import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';

/**
 * OpenChamber's agent tools served over MCP, for the engine CLIs (Claude Code
 * first). The OpenCode plugin and this endpoint are two deliveries of the same
 * tools: the definitions, the settings that turn them on, and every call's
 * execution belong to `./runtime.js`. This module owns only the protocol and
 * the per-process credentials.
 *
 * The protocol is MCP's Streamable HTTP transport, answered with plain JSON:
 * every request gets one JSON response, notifications get 202, and there is no
 * session id and no server-initiated stream (GET and DELETE answer 405). The
 * transport allows exactly that, and it is all a tool server needs.
 */

const MCP_SERVER_NAME = 'openchamber';
export const MCP_ENDPOINT_PATH = '/api/openchamber/mcp';

// Newest first. Nothing this server does differs between them.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Where a CLI puts the id of its own tool call in a tools/call request. The
// chat answers a page that waits by the call id it shows, so a page can wait
// only for a CLI listed here; another CLI's page is refused with a usage error
// that tells the agent to ask in text (`../openchamber-control/render-page.js`).
const CALL_ID_META_KEYS = ['claudecode/toolUseId'];

const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.json()).optional(),
});

const initializeParamsSchema = z.object({ protocolVersion: z.string() }).catch({ protocolVersion: '' });

const toolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.json()).optional(),
  _meta: z.record(z.string(), z.json()).optional(),
});

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const readCallId = (meta) => CALL_ID_META_KEYS
  .map((key) => asNonEmptyString(meta?.[key]))
  .find((value) => value !== null) ?? undefined;

const negotiateProtocolVersion = (params) => {
  const requested = initializeParamsSchema.parse(params ?? {}).protocolVersion;
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
};

/**
 * Claude Code defers MCP tools behind its tool search unless a tool asks to be
 * loaded up front; other clients ignore the key. A deferred tool is what Code
 * Mode is in OpenCode, so the same setting decides.
 */
const describeTool = ({ name, description, inputSchema, deferred }) => ({
  name,
  description,
  inputSchema,
  _meta: { 'anthropic/alwaysLoad': !deferred },
});

/**
 * @param {object} dependencies
 * @param {typeof import('node:crypto')} dependencies.crypto
 * @param {() => string} dependencies.endpointUrl where a CLI on this machine reaches the endpoint; throws while the listener has no port
 * @param {(address: string | undefined) => boolean} dependencies.isSameMachineAddress
 * @param {() => Promise<Array<{ name: string, description: string, inputSchema: object, deferred: boolean }>>} dependencies.listTools the tools the settings turn on now
 * @param {(name: string) => boolean} dependencies.isKnownTool
 * @param {Function} dependencies.callTool runs one call and resolves to its result envelope
 */
export const createMcpToolServer = ({ crypto, endpointUrl, isSameMachineAddress, listTools, isKnownTool, callTool }) => {
  // SHA-256 of each live token -> what the token is bound to. Looking a token
  // up by its digest tells a caller nothing about any token through timing,
  // and the token itself is kept nowhere.
  const grants = new Map();
  const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('base64url');

  /**
   * A fresh credential for one engine process, bound to its session and that
   * session's directory. Every call the token makes runs as that session; the
   * request cannot name another one.
   */
  const grant = ({ sessionId, directory }) => {
    const boundSessionId = asNonEmptyString(sessionId);
    if (!boundSessionId) throw new Error('A tool grant needs the session it belongs to');
    const url = endpointUrl();
    const token = crypto.randomBytes(32).toString('base64url');
    const key = tokenKey(token);
    // `calls` abort when the grant is revoked; `userMessages` fire when the
    // user writes to the session while a call runs.
    const binding = { sessionId: boundSessionId, directory: asNonEmptyString(directory) ?? undefined, calls: new Set(), userMessages: new Set() };
    grants.set(key, binding);
    return {
      server: { name: MCP_SERVER_NAME, url, token },
      noteUserMessage: () => {
        for (const userMessage of binding.userMessages) userMessage.abort();
      },
      revoke: () => {
        if (grants.get(key) !== binding) return;
        grants.delete(key);
        for (const call of binding.calls) call.abort();
      },
    };
  };

  const authorize = (req) => {
    if (!isSameMachineAddress(req.socket?.remoteAddress)) return null;
    const header = asNonEmptyString(req.headers?.authorization);
    if (!header?.startsWith('Bearer ')) return null;
    return grants.get(tokenKey(header.slice(7))) ?? null;
  };

  /**
   * A browser always sends Origin and a CLI never does, so refusing it keeps a
   * page the user visits from reaching the endpoint through DNS rebinding,
   * which the transport asks servers to prevent. The token alone already
   * stops such a page; this costs nothing on top.
   */
  const admit = (req, res) => {
    if (req.headers?.origin !== undefined) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    const binding = authorize(req);
    if (!binding) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return binding;
  };

  const runTool = async (binding, id, params, controller) => {
    const parsed = toolCallParamsSchema.safeParse(params ?? {});
    if (!parsed.success) return rpcError(id, RPC_ERRORS.invalidParams, 'tools/call needs the name of the tool and an arguments object');
    const { name, arguments: args = {}, _meta: meta } = parsed.data;
    // Read at call time, so a tool switched off after the CLI listed it is
    // refused rather than run.
    const tool = (await listTools()).find((entry) => entry.name === name);
    if (!tool) {
      return rpcError(id, RPC_ERRORS.invalidParams, isKnownTool(name)
        ? `${name} is turned off in OpenChamber settings`
        : `Unknown tool: ${name}`);
    }
    const userMessage = new AbortController();
    binding.calls.add(controller);
    binding.userMessages.add(userMessage);
    try {
      const envelope = await callTool(
        { tool: name, args, sessionId: binding.sessionId, directory: binding.directory, callId: readCallId(meta) },
        { signal: controller.signal, userMessage: userMessage.signal },
      );
      // A refused or failed action is still an answer, carried in the
      // envelope's `ok` the way the plugin returns it, so the chat treats the
      // call the same on every engine. Only a protocol failure is an error.
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: false });
    } finally {
      binding.calls.delete(controller);
      binding.userMessages.delete(userMessage);
    }
  };

  const dispatch = async (binding, { id, method, params }, controller) => {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'OpenChamber', version: '1.0.0' },
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: (await listTools()).map(describeTool) });
      case 'tools/call':
        return runTool(binding, id, params, controller);
      default:
        // Includes newer discovery methods; a client falls back to initialize.
        return rpcError(id, RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  };

  const answer = async (binding, req, res) => {
    const parsed = rpcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(rpcError(null, RPC_ERRORS.invalidRequest, 'Expected one JSON-RPC 2.0 request or notification'));
    }
    // A notification (initialized, cancelled) expects no answer.
    if (parsed.data.id === undefined) return res.status(202).end();
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      return res.json(await dispatch(binding, parsed.data, controller));
    } catch (error) {
      return res.json(rpcError(parsed.data.id, RPC_ERRORS.internal, error instanceof Error ? error.message : String(error)));
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  };

  /**
   * Registered with the plugin's callback, before the UI auth gate: the CLI
   * holds no UI session, and the per-process token is the credential.
   */
  const registerRoutes = (app, express) => {
    const parseBody = express.json({ limit: '1mb' });
    app.post(MCP_ENDPOINT_PATH, (req, res) => {
      const binding = admit(req, res);
      if (!binding) return;
      parseBody(req, res, (error) => {
        if (error) {
          res.status(400).json(rpcError(null, RPC_ERRORS.parse, 'Parse error'));
          return;
        }
        void answer(binding, req, res);
      });
    });
    app.all(MCP_ENDPOINT_PATH, (req, res) => {
      if (!admit(req, res)) return;
      res.set('Allow', 'POST').status(405).end();
    });
  };

  return { grant, registerRoutes };
};

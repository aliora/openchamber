import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { terminateChild } from '../cli-platform.js';
import { toolServerEnvironment } from '../tool-server.js';
import { JsonRpcConnection, JsonRpcError } from './json-rpc.js';
import { spawnCodexProcess } from './platform.js';
import {
  approvalRequestSchemas,
  notificationSchemas,
  threadResponseSchema,
  turnStartResponseSchema,
} from './protocol.js';

// One `codex app-server` per session, driven over JSON-RPC: `initialize`, the
// `initialized` notification, `thread/resume` for the session's stored thread
// or `thread/start` for a new one, then one `turn/start` per prompt. Codex's
// notifications become the engine events in ../DOCUMENTATION.md.

/**
 * What each permission mode asks Codex for: when it stops to ask
 * (`approvalPolicy`) and what its commands may touch (`sandbox`).
 */
export const CODEX_PERMISSION_MODES = {
  // Reads anything; asks before any write or command that needs more.
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  // Asks before every command except reads Codex knows to be safe.
  untrusted: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  // Codex's own default: works freely inside the workspace, asks to go beyond it.
  'on-request': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  // Never asks: whatever the sandbox blocks fails, and Codex is told so.
  never: { approvalPolicy: 'never', sandbox: 'workspace-write' },
};

// What the runtime stores on the session for this engine, read back on the next process.
const engineStateSchema = z.object({ threadId: z.string().min(1) });

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';

// How `thread/resume` answers when Codex has no history for the thread.
const MISSING_THREAD = /no rollout found/i;

// Where the tool server's token reaches Codex (../DOCUMENTATION.md, *Tool
// server*). Codex reads the bearer from this variable rather than from the
// thread config, which it stores. The name matches Codex's default shell
// environment excludes (*TOKEN*), which keep it out of the commands it runs.
const TOOL_SERVER_TOKEN_VARIABLE = 'OPENCHAMBER_MCP_TOKEN';

/**
 * The thread config that adds OpenChamber's tool server, checked against
 * codex-cli 0.163.0: Codex connects at `thread/start`, sends the bearer from
 * the variable, and lists the tools. `approve` keeps the calls from asking:
 * the tools' limits are enforced on the OpenChamber side.
 */
const toolServerConfig = ({ name, url }) => ({
  mcp_servers: {
    [name]: { url, bearer_token_env_var: TOOL_SERVER_TOKEN_VARIABLE, default_tools_approval_mode: 'approve' },
  },
});

const mcpResultText = (result) => (result?.content ?? [])
  .filter((block) => block.type === 'text' && block.text !== undefined)
  .map((block) => block.text)
  .join('\n');

const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];

const usageSince = (total, baseline) => Object.fromEntries(
  USAGE_FIELDS.map((field) => [field, Math.max(0, total[field] - baseline[field])]),
);

// Codex counts cache reads and writes inside input and reasoning inside
// output. The engine reports each apart, because the UI adds them up. The
// context the turn ends with is what its last model response read and wrote.
const toEngineUsage = (usage, lastResponse) => ({
  input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
  output: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
  reasoning: usage.reasoningOutputTokens,
  cacheRead: usage.cachedInputTokens,
  cacheWrite: usage.cacheWriteInputTokens,
  total: lastResponse.inputTokens + lastResponse.outputTokens,
});

export class CodexProcess extends EventEmitter {
  constructor(options) {
    super();
    const policy = CODEX_PERMISSION_MODES[options.permissionMode];
    if (!policy) throw new Error(`Unknown Codex permission mode: ${options.permissionMode}`);
    const engineState = engineStateSchema.safeParse(options.engineState);

    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.effort = options.effort;
    this.policy = policy;
    // `initialize` fails without `clientInfo.version`; 'unknown' matches getCurrentVersion()'s fallback.
    this.clientVersion = options.clientVersion || 'unknown';
    this.spawnProcess = options.spawnProcess || spawnCodexProcess;
    this.savedThreadId = engineState.success ? engineState.data.threadId : null;
    // `{ name, url, token }` from the engine runtime, or null for no tools.
    this.toolServer = options.toolServer ?? null;
    this.toolInstructions = options.toolInstructions ?? null;

    this.child = null;
    this.rpc = null;
    this.isAlive = false;
    this.ready = false;
    this.threadId = null;
    // Prompts wait here while a turn runs: Codex takes one turn per thread at a time.
    this.prompts = [];
    this.turn = null;
    // The thread's cumulative usage as Codex last reported it.
    this.usageTotal = null;
    // Engine request id -> JSON-RPC id of the approval request Codex is waiting on.
    this.approvals = new Map();
    // File changes of the running turn by item id, shown when Codex asks to apply them.
    this.fileChanges = new Map();
  }

  async start() {
    if (this.child) return;

    const spawnOptions = { cwd: this.cwd };
    if (this.toolServer) {
      spawnOptions.env = { ...toolServerEnvironment(this.toolServer.url), [TOOL_SERVER_TOKEN_VARIABLE]: this.toolServer.token };
    }
    const child = this.spawnProcess(['app-server'], spawnOptions);
    this.child = child;
    this.isAlive = true;
    const rpc = new JsonRpcConnection(child.stdout, child.stdin);
    this.rpc = rpc;

    rpc.on('notification', (message) => this.handleNotification(message));
    rpc.on('request', (message) => this.handleServerRequest(message));
    // Codex logs to stderr. Reading it keeps the pipe from filling up.
    child.stderr.resume();
    child.stdin.on('error', (error) => rpc.close(error));
    child.on('error', (error) => {
      this.isAlive = false;
      rpc.close(error);
      this.emit('error', error);
    });
    child.on('exit', (code, signal) => {
      this.isAlive = false;
      rpc.close(new Error(`Codex app-server exited (${signal || code})`));
      this.emit('exit', { code, signal });
    });

    await rpc.request('initialize', {
      clientInfo: { name: 'openchamber', title: 'OpenChamber', version: this.clientVersion },
      capabilities: null,
    });
    rpc.notify('initialized');
    this.threadId = await this.openThread();
    this.ready = true;
    this.startNextTurn();
  }

  async openThread() {
    const settings = {
      cwd: this.cwd,
      model: this.model,
      approvalPolicy: this.policy.approvalPolicy,
      sandbox: this.policy.sandbox,
    };
    if (this.toolServer) {
      settings.config = toolServerConfig(this.toolServer);
      if (this.toolInstructions) settings.developerInstructions = this.toolInstructions;
    }
    if (this.savedThreadId) {
      try {
        const resumed = await this.rpc.request('thread/resume', { ...settings, threadId: this.savedThreadId, excludeTurns: true });
        return threadResponseSchema.parse(resumed).thread.id;
      } catch (error) {
        // Codex no longer has the thread (deleted, or another CODEX_HOME):
        // the session goes on in a new thread, without the earlier context.
        if (!(error instanceof JsonRpcError) || !MISSING_THREAD.test(error.message)) throw error;
      }
    }
    const started = await this.rpc.request('thread/start', settings);
    return threadResponseSchema.parse(started).thread.id;
  }

  sendUserMessage(text) {
    if (!this.isAlive) throw new Error('Codex app-server is not running');
    this.prompts.push(String(text));
    this.startNextTurn();
  }

  startNextTurn() {
    if (!this.ready || this.turn || this.prompts.length === 0) return;
    const text = this.prompts.shift();
    const turn = { id: null, baseline: this.usageTotal, lastResponse: null, lastRun: null };
    this.turn = turn;

    this.rpc.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      effort: this.effort,
    }).then((result) => {
      turn.id = turnStartResponseSchema.parse(result).turn.id;
      this.saveThread();
    }).catch(() => {
      if (this.turn === turn) this.finishTurn('failed');
    });
  }

  /** Codex writes a thread to disk with its first turn; only then can a later process resume it. */
  saveThread() {
    if (this.savedThreadId === this.threadId) return;
    this.savedThreadId = this.threadId;
    this.emit('engine.state', { threadId: this.threadId });
  }

  /** The running turn, when `turnId` belongs to it. */
  currentTurn(turnId) {
    if (!this.turn) return null;
    return !this.turn.id || this.turn.id === turnId ? this.turn : null;
  }

  handleNotification({ method, params }) {
    const schema = notificationSchemas.get(method);
    if (!schema) return;
    const parsed = schema.safeParse(params);
    if (!parsed.success) return;
    const data = parsed.data;
    // Approvals are answered whichever thread asked, so they are forgotten the same way.
    if (method === 'serverRequest/resolved') {
      this.forgetApproval(data.requestId);
      return;
    }
    // Sub-agent threads report on the same connection; only this session's thread counts.
    if (data.threadId !== this.threadId) return;

    switch (method) {
      case 'item/agentMessage/delta':
        this.handleTextDelta(data);
        break;
      case 'item/reasoning/summaryTextDelta':
        this.handleReasoningDelta(data);
        break;
      case 'item/started':
        this.handleItemStarted(data);
        break;
      case 'item/completed':
        this.handleMcpCallCompleted(data);
        break;
      case 'thread/tokenUsage/updated':
        this.handleUsage(data);
        break;
      case 'turn/completed':
        if (this.currentTurn(data.turn.id)) this.finishTurn(data.turn.status === 'completed' ? 'succeeded' : 'failed');
        break;
    }
  }

  handleTextDelta({ turnId, itemId, delta }) {
    const turn = this.currentTurn(turnId);
    if (!turn) return;
    this.emitRunDelta(turn, 'text', itemId, delta);
  }

  handleReasoningDelta({ turnId, itemId, summaryIndex, delta }) {
    const turn = this.currentTurn(turnId);
    if (!turn) return;
    this.emitRunDelta(turn, 'reasoning', `${itemId}:${summaryIndex}`, delta);
  }

  /**
   * Codex can answer in several messages per turn and summarize its reasoning
   * in several parts. A blank line keeps two of them apart when one follows
   * the other directly. With a tool call or the other kind in between, the
   * chat already shows them as separate parts, so nothing is added.
   */
  emitRunDelta(turn, type, key, delta) {
    if (turn.lastRun?.type === type && turn.lastRun.key !== key) this.emit(`${type}.delta`, { text: '\n\n' });
    turn.lastRun = { type, key };
    this.emit(`${type}.delta`, { text: delta });
  }

  emitToolStarted(turn, call) {
    turn.lastRun = null;
    this.emit('tool.started', call);
  }

  handleItemStarted({ turnId, item }) {
    const turn = this.currentTurn(turnId);
    if (!turn) return;
    switch (item.type) {
      case 'commandExecution':
        this.emitToolStarted(turn, { id: item.id, name: 'shell', input: { command: item.command, cwd: item.cwd } });
        break;
      case 'fileChange':
        this.fileChanges.set(item.id, item.changes);
        this.emitToolStarted(turn, {
          id: item.id,
          name: 'edit',
          input: { changes: item.changes.map((change) => ({ path: change.path, kind: change.kind.type })) },
        });
        break;
      case 'mcpToolCall': {
        // The tool server's own tools keep their own names, which the chat
        // renders them by. Codex reports the whole input at the start.
        const name = item.server === this.toolServer?.name ? item.tool : `mcp__${item.server}__${item.tool}`;
        this.emitToolStarted(turn, { id: item.id, name, input: item.arguments });
        this.emit('tool.called', { id: item.id, name, input: item.arguments });
        break;
      }
    }
  }

  handleMcpCallCompleted({ turnId, item }) {
    if (!this.currentTurn(turnId)) return;
    const failed = item.status !== 'completed' || Boolean(item.error);
    this.emit('tool.completed', {
      id: item.id,
      output: failed && item.error ? item.error.message : mcpResultText(item.result),
      isError: failed,
    });
  }

  /**
   * Codex reports the thread's running total and that response's own usage
   * (`last`) after each model response, and may repeat a report. A turn's
   * usage is how far the total grew during the turn. When no earlier total is
   * known (a resumed thread), the total before the turn's first response is
   * the starting point. The turn's last response gives its context size.
   */
  handleUsage({ turnId, tokenUsage }) {
    const turn = this.currentTurn(turnId);
    if (turn) {
      turn.baseline ??= usageSince(tokenUsage.total, tokenUsage.last);
      turn.lastResponse = tokenUsage.last;
    }
    this.usageTotal = tokenUsage.total;
  }

  finishTurn(outcome) {
    const turn = this.turn;
    this.turn = null;
    this.fileChanges.clear();
    const usage = turn.lastResponse ? toEngineUsage(usageSince(this.usageTotal, turn.baseline), turn.lastResponse) : null;
    this.emit('turn.completed', { outcome, usage });
    this.startNextTurn();
  }

  handleServerRequest({ id, method, params }) {
    const schema = approvalRequestSchemas.get(method);
    if (!schema) {
      this.rpc.respondError(id, METHOD_NOT_FOUND, `OpenChamber does not handle ${method}`);
      return;
    }
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      this.rpc.respondError(id, INVALID_PARAMS, `Unexpected ${method} params`);
      return;
    }

    const requestId = crypto.randomUUID();
    this.approvals.set(requestId, id);
    this.emit('permission.requested', method === COMMAND_APPROVAL
      ? this.describeCommandApproval(requestId, parsed.data)
      : this.describeFileApproval(requestId, parsed.data));
  }

  describeCommandApproval(requestId, { command, cwd, reason }) {
    return {
      requestId,
      toolName: 'shell',
      input: { command, cwd, reason },
      summary: reason || command || 'Codex wants to run a command',
    };
  }

  describeFileApproval(requestId, { itemId, reason }) {
    const changes = this.fileChanges.get(itemId) || [];
    const paths = changes.map((change) => change.path);
    return {
      requestId,
      toolName: 'edit',
      input: {
        path: paths[0],
        changes: changes.map((change) => ({ path: change.path, kind: change.kind.type, diff: change.diff })),
        reason,
      },
      summary: reason || (paths.length > 0 ? `Codex wants to change ${paths.join(', ')}` : 'Codex wants to change files'),
    };
  }

  /** Codex resolved the request itself, for example because the turn ended. */
  forgetApproval(rpcId) {
    for (const [requestId, pendingId] of this.approvals) {
      if (pendingId === rpcId) this.approvals.delete(requestId);
    }
  }

  respondPermission(requestId, behavior) {
    const rpcId = this.approvals.get(requestId);
    if (rpcId === undefined) return;
    this.approvals.delete(requestId);
    // `decline` lets Codex go on without the action; `cancel` would also end the turn.
    this.rpc.respond(rpcId, { decision: behavior === 'allow' ? 'accept' : 'decline' });
  }

  async abort() {
    if (!this.child) return;
    await terminateChild(this.child);
    this.isAlive = false;
  }
}

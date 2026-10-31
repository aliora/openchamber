import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { z } from 'zod';
import { toolServerEnvironment } from '../tool-server.js';
import { appendAttachmentPaths } from '../attachment-delivery.js';
import { writeClaudeMcpConfig } from './mcp-config.js';
import { spawnClaudeProcess, terminateClaudeProcess } from './platform.js';

const MAX_INLINE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

// Whole conversation messages in the stream: the assistant's, with each tool
// call's final input, and the user's, which carry the tool results. A
// subagent's own messages name the call that runs it and stay out of this
// session's transcript.
const conversationMessageSchema = z.object({
  type: z.enum(['assistant', 'user']),
  parent_tool_use_id: z.string().nullable().optional(),
  // A prompt from stdin, echoed back by --replay-user-messages at the moment
  // Claude takes it into the conversation.
  isReplay: z.boolean().optional().catch(undefined),
  message: z.object({ content: z.array(z.looseObject({ type: z.string() })).catch([]) }),
});

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.json()).catch({}),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  ]).optional().catch(undefined),
  is_error: z.boolean().optional().catch(undefined),
});

// Claude's answer to a control request this process sent, such as
// `set_permission_mode`: `success`, or `error` with the reason.
const controlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.enum(['success', 'error']),
    request_id: z.string().min(1),
    error: z.string().optional().catch(undefined),
  }),
});

// Claude answers a control request at once; one that never answers must not
// hold the route that sent it.
const CONTROL_REQUEST_TIMEOUT_MS = 5000;

// The token counts of one model call. `message_start` has what the call read
// and a partial output count; `message_delta` has the final counts, where a
// field the API leaves null keeps its `message_start` value. A subagent's own
// calls name the call that runs it.
const callUsageSchema = z.object({
  input_tokens: z.number().nonnegative().nullish().catch(null),
  cache_creation_input_tokens: z.number().nonnegative().nullish().catch(null),
  cache_read_input_tokens: z.number().nonnegative().nullish().catch(null),
  output_tokens: z.number().nonnegative().nullish().catch(null),
});

const callUsageEventSchema = z.object({
  parent_tool_use_id: z.string().nullable().optional(),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('message_start'), message: z.object({ usage: callUsageSchema }) }),
    z.object({ type: z.literal('message_delta'), usage: callUsageSchema }),
  ]),
});

const backgroundTasksSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('background_tasks_changed'),
  tasks: z.array(z.object({
    task_id: z.string().min(1),
    task_type: z.string().optional().catch(undefined),
    description: z.string().optional().catch(undefined),
  })),
});

const CALL_USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

// A result is text or a list of blocks; only its text reaches the chat.
const toolResultText = (content) => {
  if (content === undefined) return '';
  if (!Array.isArray(content)) return content;
  return content.filter((block) => block.type === 'text' && block.text !== undefined).map((block) => block.text).join('\n');
};

export const buildClaudeCliArgs = (options = {}) => {
  const args = [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    // Claude takes a prompt that arrives mid-turn into the running turn at
    // its next tool boundary and answers both with one result. The echo of
    // each prompt, sent when Claude takes it, is how the runtime learns that.
    '--replay-user-messages',
    // Permission prompts arrive on stdout as `can_use_tool` control requests.
    // (`--permission-prompts host` denies them instead in this mode.)
    '--permission-prompt-tool',
    'stdio',
  ];

  if (options.sessionId) {
    // Claude refuses a --session-id it already keeps a transcript for, and
    // --resume of an id it has never seen; only one of them is right.
    args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  }

  // OpenChamber's own tools, from the file mcp-config.js wrote; the token is
  // in that file, never here. The user's own MCP servers still load.
  // Pre-allowed: these tools run without a permission prompt, as they did as
  // OpenCode plugin tools. Their limits are enforced on the server (the
  // settings that turn each tool off, a fixed action allowlist, nothing
  // destructive), and the modes would otherwise break them: `dontAsk` denies
  // every tool that is not allowed, `auto` leaves each call to the
  // classifier, and `manual` asks for every browser click. A deny rule in the
  // user's own settings still wins over this allow.
  if (options.toolServer && options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath);
    args.push('--allowedTools', `mcp__${options.toolServer.name}__*`);
    if (options.toolInstructions) args.push('--append-system-prompt', options.toolInstructions);
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.permissionMode) {
    if (options.permissionMode === 'bypass' || options.permissionMode === 'bypassPermissions') {
      args.push('--permission-mode', 'bypassPermissions');
    } else {
      args.push('--permission-mode', options.permissionMode);
    }
  }

  return args;
};

export class ClaudeProcess extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId;
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.effort = options.effort;
    this.permissionMode = options.permissionMode;
    this.resume = Boolean(options.resume);
    // `{ name, url, token }` from the engine runtime, or null for no tools.
    this.toolServer = options.toolServer ?? null;
    this.toolInstructions = options.toolInstructions ?? null;
    this.mcpConfigDirectory = options.mcpConfigDirectory;
    this.spawn = options.spawn ?? spawnClaudeProcess;
    this.controlRequestTimeoutMs = options.controlRequestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;

    this.child = null;
    this.rl = null;
    this.mcpConfig = null;
    this.isAlive = false;
    this.exitCode = null;
    // The usage `message_start` reported for the model call still streaming.
    this.callStart = null;
    // Control requests this process sent, by request id, until Claude answers.
    this.pendingControl = new Map();
  }

  rejectPendingControl(error) {
    for (const pending of this.pendingControl.values()) pending.reject(error);
    this.pendingControl.clear();
  }

  removeMcpConfig() {
    this.mcpConfig?.remove();
    this.mcpConfig = null;
  }

  start() {
    if (this.child) return Promise.resolve();

    this.mcpConfig = this.toolServer ? writeClaudeMcpConfig(this.toolServer, this.mcpConfigDirectory) : null;
    const args = buildClaudeCliArgs({
      sessionId: this.sessionId,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      resume: this.resume,
      toolServer: this.toolServer,
      toolInstructions: this.toolInstructions,
      mcpConfigPath: this.mcpConfig?.path,
    });

    try {
      this.child = this.spawn(args, {
        cwd: this.cwd,
        env: this.toolServer ? toolServerEnvironment(this.toolServer.url) : process.env,
      });
    } catch (error) {
      this.removeMcpConfig();
      throw error;
    }
    this.isAlive = true;

    this.rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      this.handleOutputLine(line);
    });

    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.emit('stderr', text);
    });

    // Writing to Claude after it exited fails with EPIPE on stdin, and an
    // unhandled stream error would take the whole server down.
    this.child.stdin.on('error', (err) => {
      this.emit('error', err);
    });

    // A spawn failure reports `error` without `exit`, so both remove the
    // config, and its token with it.
    this.child.on('error', (err) => {
      this.removeMcpConfig();
      this.rejectPendingControl(err);
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.isAlive = false;
      this.exitCode = code;
      this.removeMcpConfig();
      this.rejectPendingControl(new Error('Claude Code exited before it answered'));
      this.emit('exit', { code, signal });
    });

    return Promise.resolve();
  }

  handleOutputLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const obj = JSON.parse(trimmed);
      this.emit('raw_event', obj);

      if (obj.type === 'system' && obj.subtype === 'init') {
        this.emit('init', obj);
        return;
      }

      if (obj.type === 'system' && obj.subtype === 'background_tasks_changed') {
        this.handleBackgroundTasks(obj);
        return;
      }

      if (obj.type === 'stream_event' && obj.event) {
        const ev = obj.event;

        if (ev.type === 'message_start' || ev.type === 'message_delta') {
          this.handleCallUsage(obj);
          return;
        }

        if (ev.type === 'content_block_start') {
          if (ev.content_block?.type === 'thinking') {
            this.emit('thinking_start', { index: ev.index });
          } else if (ev.content_block?.type === 'tool_use') {
            this.emit('tool_use_start', {
              index: ev.index,
              id: ev.content_block.id,
              name: ev.content_block.name,
              input: ev.content_block.input || {},
            });
          }
          return;
        }

        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'thinking_delta') {
            this.emit('thinking_delta', {
              index: ev.index,
              text: ev.delta.thinking,
            });
          } else if (ev.delta.type === 'text_delta') {
            this.emit('text_delta', {
              index: ev.index,
              text: ev.delta.text,
            });
          } else if (ev.delta.type === 'input_json_delta') {
            this.emit('tool_use_delta', {
              index: ev.index,
              partialJson: ev.delta.partial_json,
            });
          }
          return;
        }

        if (ev.type === 'content_block_stop') {
          this.emit('content_block_stop', { index: ev.index });
          return;
        }
      }

      if (obj.type === 'control_response') {
        this.handleControlResponse(obj);
        return;
      }

      if (obj.type === 'control_request') {
        const req = obj.request || {};
        this.emit('control_request', {
          requestId: obj.request_id,
          subtype: req.subtype,
          toolName: req.tool_name,
          command: req.input?.command,
          input: req.input,
          raw: obj,
        });
        return;
      }

      if (obj.type === 'assistant' || obj.type === 'user') {
        this.handleConversationMessage(obj);
        if (obj.type === 'assistant' && obj.message) this.emit('assistant_message', obj.message);
        return;
      }

      if (obj.type === 'result') {
        this.emit('result', {
          subtype: obj.subtype,
          isError: obj.is_error === true,
          result: obj.result,
          durationMs: obj.duration_ms,
          usage: obj.usage,
          modelUsage: obj.modelUsage,
        });
        return;
      }
    } catch {
      // Non-JSON line from stdout
      this.emit('stdout_text', line);
    }
  }

  handleBackgroundTasks(raw) {
    const parsed = backgroundTasksSchema.safeParse(raw);
    if (!parsed.success) return;
    this.emit('background_tasks', parsed.data.tasks.map((task) => ({
      id: task.task_id,
      type: task.task_type ?? '',
      description: task.description ?? '',
    })));
  }

  /**
   * `call_usage` with the final token counts of each model call this
   * session's conversation makes. The `assistant` messages carry only the
   * counts from the start of the call, before the output was written.
   */
  handleCallUsage(raw) {
    const parsed = callUsageEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.parent_tool_use_id) return;
    const { event } = parsed.data;
    if (event.type === 'message_start') {
      this.callStart = event.message.usage;
      this.emit('call_started');
      return;
    }
    const start = this.callStart;
    this.callStart = null;
    this.emit('call_usage', Object.fromEntries(
      CALL_USAGE_FIELDS.map((field) => [field, event.usage[field] ?? start?.[field] ?? 0]),
    ));
  }

  /**
   * `prompt_consumed` when Claude takes a prompt into the conversation,
   * `tool_use` once a call's input is final (the call runs next), and
   * `tool_result` with what the call returned.
   */
  handleConversationMessage(raw) {
    const parsed = conversationMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.parent_tool_use_id) {
      this.emitSubagentToolUses(parsed.data);
      return;
    }
    if (parsed.data.isReplay === true) {
      this.emit('prompt_consumed');
      return;
    }
    for (const block of parsed.data.message.content) {
      const toolUse = toolUseBlockSchema.safeParse(block);
      if (toolUse.success) {
        this.emit('tool_use', { id: toolUse.data.id, name: toolUse.data.name, input: toolUse.data.input });
        continue;
      }
      const toolResult = toolResultBlockSchema.safeParse(block);
      if (toolResult.success) {
        this.emit('tool_result', {
          id: toolResult.data.tool_use_id,
          output: toolResultText(toolResult.data.content),
          isError: toolResult.data.is_error === true,
        });
      }
    }
  }

  /** `subagent_tool_use` for each call a subagent's own assistant message makes. */
  emitSubagentToolUses({ type, parent_tool_use_id: parentId, message }) {
    if (type !== 'assistant') return;
    for (const block of message.content) {
      const toolUse = toolUseBlockSchema.safeParse(block);
      if (toolUse.success) this.emit('subagent_tool_use', { parentId, name: toolUse.data.name, input: toolUse.data.input });
    }
  }

  handleControlResponse(raw) {
    const parsed = controlResponseSchema.safeParse(raw);
    if (!parsed.success) return;
    const { subtype, request_id: requestId, error } = parsed.data.response;
    const pending = this.pendingControl.get(requestId);
    if (!pending) return;
    this.pendingControl.delete(requestId);
    if (subtype === 'success') pending.resolve();
    else pending.reject(new Error(error || 'Claude Code refused the control request'));
  }

  /**
   * Sends a control request, the way an SDK host does, and resolves once
   * Claude answers it with success. Rejects with Claude's reason on an error
   * answer, after the timeout, or when the process ends first.
   */
  sendControlRequest(request) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error('Claude process stdin is not writable'));
    }
    const requestId = `oc_${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`Claude Code did not answer ${request.subtype} in time`));
      }, this.controlRequestTimeoutMs);
      this.pendingControl.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
    });
  }

  /**
   * Switches the running CLI to another permission mode. Claude Code 2.1.302
   * takes every mode this way except `bypassPermissions`, which it refuses
   * (`bypass_not_launched`) unless the process was launched in it.
   */
  setPermissionMode(mode) {
    return this.sendControlRequest({ subtype: 'set_permission_mode', mode });
  }

  sendUserMessage(text, attachments = []) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('Claude process stdin is not writable');
    }

    const isInlineImage = (item) => item.kind === 'image' && item.size <= MAX_INLINE_IMAGE_BYTES;
    const images = attachments.filter(isInlineImage).map((item) => ({
      type: 'image',
      source: { type: 'base64', media_type: item.mime, data: fs.readFileSync(item.path).toString('base64') },
    }));
    const body = appendAttachmentPaths(String(text), attachments, (item) => !isInlineImage(item));
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: body ? [...images, { type: 'text', text: body }] : images,
      },
    };

    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  sendControlResponse(requestId, behavior = 'allow') {
    // A denial without a message reads to the agent as an empty refusal.
    this.sendPermissionResult(requestId, behavior === 'deny' ? { behavior, message: 'The user denied this action.' } : { behavior });
  }

  sendPermissionResult(requestId, result) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('Claude process stdin is not writable');
    }

    const payload = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: result,
      },
    };

    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  async abort() {
    if (this.child) {
      await terminateClaudeProcess(this.child);
      this.isAlive = false;
    }
  }
}

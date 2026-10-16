import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { spawnClaudeProcess, terminateClaudeProcess } from './platform.js';

export const buildClaudeCliArgs = (options = {}) => {
  const args = [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-prompts',
    'host',
  ];

  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
    if (options.forkSession) {
      args.push('--fork-session');
      if (options.resume) {
        args.push('--resume');
      }
    }
  } else if (options.resume) {
    args.push('--resume');
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

    this.child = null;
    this.rl = null;
    this.isAlive = false;
    this.exitCode = null;
  }

  start() {
    if (this.child) return Promise.resolve();

    const args = buildClaudeCliArgs({
      sessionId: this.sessionId,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      resume: this.resume,
    });

    this.child = spawnClaudeProcess(args, { cwd: this.cwd });
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

    this.child.on('error', (err) => {
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.isAlive = false;
      this.exitCode = code;
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

      if (obj.type === 'stream_event' && obj.event) {
        const ev = obj.event;

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

      if (obj.type === 'assistant' && obj.message) {
        this.emit('assistant_message', obj.message);
        return;
      }

      if (obj.type === 'result') {
        this.emit('result', {
          subtype: obj.subtype,
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

  sendUserMessage(text) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('Claude process stdin is not writable');
    }

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
      },
    };

    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  sendControlResponse(requestId, behavior = 'allow') {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('Claude process stdin is not writable');
    }

    const payload = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior,
        },
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

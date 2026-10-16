import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { z } from 'zod';
import { spawnAgyProcess, terminateAgyProcess } from './platform.js';

// One long-lived `agy --input-format stream-json --output-format stream-json`
// per session. agy reads one `user` message per stdin line and answers it as one
// turn of the same conversation: an optional `init`, `step_update` events, then
// one `result`. Its docs say to wait for that `result` before writing the next
// prompt, so prompts queue here and go out one at a time.
//
// Headless agy cannot ask the host for approval: a tool the permission mode
// does not allow is refused inside agy and the agent sees the refusal. This
// process therefore never emits `permission.requested`.

export const DEFAULT_MODEL = 'default';

const PERMISSION_FLAGS = {
  default: [],
  'accept-edits': ['--mode', 'accept-edits'],
  auto: ['--mode', 'auto'],
  'dangerously-skip-permissions': ['--dangerously-skip-permissions'],
};

// The agy conversation this session continues, stored by the runtime between processes.
const engineStateSchema = z.object({ conversationId: z.guid() });

const lenient = (schema) => schema.optional().catch(undefined);
const tokenCount = z.number().nonnegative().catch(0);

// agy counts cache reads inside input_tokens and thinking inside output_tokens:
// total_tokens is always input_tokens + output_tokens.
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  thinking_tokens: tokenCount,
  cache_read_tokens: tokenCount,
});

const agyEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('init'),
    conversation_id: lenient(z.string()),
  }),
  z.object({
    event: z.literal('step_update'),
    step_update: z.object({
      step_index: lenient(z.number()),
      state: lenient(z.string()),
      step_type: lenient(z.string()),
      text_delta: lenient(z.string()),
      tool_name: lenient(z.string()),
      tool_info: lenient(z.object({
        name: lenient(z.string()),
        parameters: lenient(z.record(z.string(), z.unknown())),
      })),
      usage: lenient(usageSchema),
    }),
  }),
  // Every field is optional so a malformed result still ends the turn.
  z.object({
    event: z.literal('result'),
    result: lenient(z.object({
      status: lenient(z.string()),
    })),
  }),
]);

export const buildAgyCliArgs = ({ model, effort, permissionMode = 'default', conversationId }) => {
  const permissionFlags = PERMISSION_FLAGS[permissionMode];
  if (!permissionFlags) throw new Error(`Unknown Antigravity permission mode: ${permissionMode}`);

  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...permissionFlags];
  if (conversationId) args.push('--conversation', conversationId);
  // `default` leaves the model, and the effort saved with it, to the CLI's own settings.
  if (model && model !== DEFAULT_MODEL) {
    args.push('--model', model);
    if (effort) args.push('--effort', effort);
  }
  return args;
};

const parseLine = (line) => {
  try {
    const parsed = agyEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const toEngineUsage = (stepUsage) => {
  const sum = { input: 0, output: 0, thinking: 0, cacheRead: 0 };
  for (const usage of stepUsage.values()) {
    sum.input += usage.input_tokens;
    sum.output += usage.output_tokens;
    sum.thinking += usage.thinking_tokens;
    sum.cacheRead += usage.cache_read_tokens;
  }
  return {
    input: Math.max(0, sum.input - sum.cacheRead),
    output: Math.max(0, sum.output - sum.thinking),
    reasoning: sum.thinking,
    cacheRead: sum.cacheRead,
    cacheWrite: 0,
  };
};

export class AgyProcess extends EventEmitter {
  constructor({
    cwd,
    model,
    effort,
    permissionMode,
    engineState,
    spawnProcess = spawnAgyProcess,
    terminateProcess = terminateAgyProcess,
  }) {
    super();
    const state = engineStateSchema.safeParse(engineState);
    this.conversationId = state.success ? state.data.conversationId : null;
    this.args = buildAgyCliArgs({ model, effort, permissionMode, conversationId: this.conversationId });
    this.cwd = cwd || process.cwd();
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;

    this.child = null;
    this.isAlive = false;
    this.aborting = false;
    this.queue = [];
    // The turn agy is answering: usage per step index, tool steps already announced,
    // and whether agy reported an error during it.
    this.turn = null;
  }

  start() {
    if (this.child) return Promise.resolve();
    this.child = this.spawnProcess(this.args, { cwd: this.cwd });
    this.isAlive = true;

    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on('line', (line) => this.handleOutputLine(line));
    readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity })
      .on('line', (line) => this.handleErrorLine(line));
    // A write after agy exited fails with EPIPE; the exit handler ends the turn.
    this.child.stdin.on('error', () => {});
    this.child.on('error', (error) => {
      this.isAlive = false;
      this.emit('error', error);
    });
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    return Promise.resolve();
  }

  sendUserMessage(text) {
    if (!this.isAlive || !this.child.stdin.writable) {
      throw new Error('Antigravity process stdin is not writable');
    }
    this.queue.push(String(text));
    this.writeNextPrompt();
  }

  writeNextPrompt() {
    if (this.turn || this.queue.length === 0) return;
    const content = this.queue.shift();
    this.turn = { stepUsage: new Map(), announcedTools: new Set(), failed: false };
    this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`);
  }

  handleOutputLine(line) {
    const event = parseLine(line.trim());
    if (!event) return;
    if (event.event === 'init') this.handleInit(event);
    else if (event.event === 'step_update') this.handleStep(event.step_update);
    else this.completeTurn(event.result?.status === 'SUCCESS' ? 'succeeded' : 'failed');
  }

  handleInit({ conversation_id: conversationId }) {
    if (!conversationId || conversationId === this.conversationId) return;
    // A resumed conversation agy could not find starts over under a new id.
    this.conversationId = conversationId;
    this.emit('engine.state', { conversationId });
  }

  handleStep(step) {
    if (!this.turn) return;
    const stepIndex = step.step_index ?? -1;
    // Each update of a step repeats that step's usage so far, so the last one counts.
    if (step.usage) this.turn.stepUsage.set(stepIndex, step.usage);

    if (step.step_type === 'agent_response' && step.text_delta) {
      this.emit('text.delta', { text: step.text_delta });
      return;
    }
    if (step.step_type === 'tool' && !this.turn.announcedTools.has(stepIndex)) {
      this.turn.announcedTools.add(stepIndex);
      this.emit('tool.started', {
        id: `${this.conversationId || 'agy'}:${stepIndex}`,
        name: step.tool_name || step.tool_info?.name || 'tool',
        input: step.tool_info?.parameters || {},
      });
    }
  }

  handleErrorLine(line) {
    // A turn that ends on a model or agent error prints `AGY_ERROR: {...}` (agy 1.2.6 and later).
    if (this.turn && line.startsWith('AGY_ERROR:')) this.turn.failed = true;
  }

  completeTurn(outcome) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.emit('turn.completed', {
      outcome: turn.failed ? 'failed' : outcome,
      usage: toEngineUsage(turn.stepUsage),
    });
    this.writeNextPrompt();
  }

  handleExit(code, signal) {
    this.isAlive = false;
    this.queue = [];
    // Exit code 3 marks a model or agent error; any exit mid-turn fails the turn.
    if (!this.aborting) this.completeTurn('failed');
    this.emit('exit', { code, signal });
  }

  respondPermission() {
    throw new Error('Antigravity does not ask the host for permission in headless mode');
  }

  async abort() {
    this.aborting = true;
    this.queue = [];
    if (this.child) await this.terminateProcess(this.child);
    this.isAlive = false;
  }
}

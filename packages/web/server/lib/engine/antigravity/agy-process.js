import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { z } from 'zod';
import { toolServerEnvironment } from '../tool-server.js';
import { appendAttachmentPaths } from '../attachment-delivery.js';
import { spawnAgyProcess, terminateAgyProcess } from './platform.js';
import { watchAgyQuestions } from './question-hook.js';
import { agyServerName, writeAgyToolPlugin } from './tool-plugin.js';

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
        output: lenient(z.string()),
        error: lenient(z.object({ message: lenient(z.string()) })),
      })),
      usage: lenient(usageSchema),
    }),
  }),
  // Every field is optional so a malformed result still ends the turn.
  z.object({
    event: z.literal('result'),
    result: lenient(z.object({
      status: lenient(z.string()),
      response: lenient(z.string()),
      error: lenient(z.string()),
      denied_actions: lenient(z.array(z.object({
        action: lenient(z.string()),
        display_name: lenient(z.string()),
      }))),
    })),
  }),
]);

export const buildAgyCliArgs = ({ model, effort, permissionMode = 'default', conversationId, addDir }) => {
  const permissionFlags = PERMISSION_FLAGS[permissionMode];
  if (!permissionFlags) throw new Error(`Unknown Antigravity permission mode: ${permissionMode}`);

  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...permissionFlags];
  if (conversationId) args.push('--conversation', conversationId);
  if (addDir) args.push('--add-dir', addDir);
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

// Each step's usage is one model call, which re-reads the whole conversation.
// The turn's usage adds up its steps; the context it ends with is what its
// last step with usage read and wrote.
const toEngineUsage = (stepUsage) => {
  const sum = { input: 0, output: 0, thinking: 0, cacheRead: 0 };
  for (const usage of stepUsage.values()) {
    sum.input += usage.input_tokens;
    sum.output += usage.output_tokens;
    sum.thinking += usage.thinking_tokens;
    sum.cacheRead += usage.cache_read_tokens;
  }
  const usage = {
    input: Math.max(0, sum.input - sum.cacheRead),
    output: Math.max(0, sum.output - sum.thinking),
    reasoning: sum.thinking,
    cacheRead: sum.cacheRead,
    cacheWrite: 0,
  };
  const lastStep = [...stepUsage.values()].at(-1);
  if (lastStep) usage.total = lastStep.input_tokens + lastStep.output_tokens;
  return usage;
};

const SETTINGS_PATH = '~/.gemini/antigravity-cli/settings.json';

const deniedActionsError = (deniedActions) => {
  const permissions = [...new Set(deniedActions.map((denied) => denied.action ?? denied.display_name).filter(Boolean))];
  const named = permissions.map((permission) => `"${permission}"`).join(', ');
  const rules = permissions.map((permission) => `${permission}(<target>)`).join(', ');
  return {
    type: 'PermissionDenied',
    message: `Antigravity needed the ${named} permission, which headless agy cannot ask for, so the call was refused and the turn has no answer. `
      + `Switch this chat's permission mode to "dangerously-skip-permissions", or add an allow rule such as ${rules} under permissions.allow in ${SETTINGS_PATH}.`,
  };
};

const AUTH_FAILURE = /authentication (?:required|failed)/i;

const NOT_SIGNED_IN = {
  type: 'AuthRequired',
  message: 'Antigravity is not signed in, so it cannot answer. Run `agy` in a terminal and type /login, or sign in from the setup wizard or Settings → Engines, then send the prompt again.',
};

const MCP_TOOL = 'call_mcp_tool';
const DENIED_TOOL_ERROR = /denied permission/i;
const REFUSED_TOOL_PERMISSIONS = { run_command: 'command' };
const FINISHED_TOOL_STATES = new Set(['DONE', 'ERROR']);

const mcpCallSchema = z.object({
  ServerName: z.string(),
  ToolName: z.string(),
  Arguments: z.record(z.string(), z.unknown()).catch({}),
});

const ANSWERED_PREFIX = 'Not an error: OpenChamber showed your ask_question to the user, who answered it. Treat these answers as its result and continue:';
const DISMISSED = 'Not an error: OpenChamber showed your ask_question to the user, who closed it without answering. If they wrote in the chat instead, their message follows; otherwise continue with your best judgment and do not ask the same question again.';

const questionDecision = (questions, answers) => ({
  decision: 'deny',
  reason: answers
    ? [ANSWERED_PREFIX, ...questions.map(({ question }, index) => `- ${question}: ${(answers[`q${index}`] ?? []).join(', ') || '(no answer)'}`)].join('\n')
    : DISMISSED,
});

const toolCallFor = (step, ownServer) => {
  const name = step.tool_name || step.tool_info?.name || 'tool';
  const parameters = step.tool_info?.parameters || {};
  const mcpCall = name === MCP_TOOL ? mcpCallSchema.safeParse(parameters) : null;
  if (!mcpCall?.success) return { name, input: parameters };
  const { ServerName: server, ToolName: tool, Arguments: input } = mcpCall.data;
  if (server === ownServer) return { name: tool, input, own: true };
  return { name: `mcp__${server}__${tool}`, input };
};

export class AgyProcess extends EventEmitter {
  constructor({
    cwd,
    model,
    effort,
    permissionMode,
    engineState,
    toolServer = null,
    toolInstructions = null,
    toolPluginDirectory,
    platform = process.platform,
    questionPollIntervalMs,
    spawnProcess = spawnAgyProcess,
    terminateProcess = terminateAgyProcess,
  }) {
    super();
    const state = engineStateSchema.safeParse(engineState);
    this.conversationId = state.success ? state.data.conversationId : null;
    this.cliOptions = { model, effort, permissionMode, conversationId: this.conversationId };
    this.args = buildAgyCliArgs(this.cliOptions);
    this.toolServer = toolServer;
    this.toolInstructions = toolInstructions;
    this.toolPluginDirectory = toolPluginDirectory;
    this.toolPlugin = null;
    this.askQuestions = platform !== 'win32';
    this.questionPollIntervalMs = questionPollIntervalMs;
    this.questionHook = null;
    this.questions = new Map();
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
    const spawnOptions = { cwd: this.cwd };
    if (this.toolServer || this.askQuestions) {
      this.toolPlugin = writeAgyToolPlugin({
        toolServer: this.toolServer,
        instructions: this.toolInstructions,
        askQuestions: this.askQuestions,
      }, this.toolPluginDirectory);
      this.args = buildAgyCliArgs({ ...this.cliOptions, addDir: this.toolPlugin.root });
    }
    if (this.toolServer) spawnOptions.env = toolServerEnvironment(this.toolServer.url);
    if (this.askQuestions) {
      this.questionHook = watchAgyQuestions({
        directory: this.toolPlugin.plugin,
        onQuestion: (question) => this.askQuestion(question),
        intervalMs: this.questionPollIntervalMs,
      });
    }
    try {
      this.child = this.spawnProcess(this.args, spawnOptions);
    } catch (error) {
      this.removeToolPlugin();
      throw error;
    }
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

  sendUserMessage(text, attachments = []) {
    if (!this.isAlive || !this.child.stdin.writable) {
      throw new Error('Antigravity process stdin is not writable');
    }
    this.queue.push(appendAttachmentPaths(String(text), attachments, () => true));
    this.writeNextPrompt();
  }

  writeNextPrompt() {
    if (this.turn || this.queue.length === 0) return;
    const content = this.queue.shift();
    this.turn = { stepUsage: new Map(), announcedTools: new Set(), finishedTools: new Set(), failed: false, answered: false };
    this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`);
  }

  handleOutputLine(line) {
    const event = parseLine(line.trim());
    if (!event) return;
    if (event.event === 'init') this.handleInit(event);
    else if (event.event === 'step_update') this.handleStep(event.step_update);
    else this.handleResult(event.result);
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
      this.turn.answered = true;
      this.emit('text.delta', { text: step.text_delta });
      return;
    }
    if (step.step_type === 'tool') this.handleToolStep(step, stepIndex);
  }

  trackRefusedTool(step) {
    if (step.state !== 'ERROR' || !DENIED_TOOL_ERROR.test(step.tool_info?.error?.message ?? '')) return;
    this.turn.refusedTool = REFUSED_TOOL_PERMISSIONS[step.tool_name] ?? step.tool_name ?? 'tool';
  }

  handleToolStep(step, stepIndex) {
    this.trackRefusedTool(step);
    const id = `${this.conversationId || 'agy'}:${stepIndex}`;
    const ownServer = this.toolServer ? agyServerName(this.toolServer.name) : null;
    const { own, ...call } = toolCallFor(step, ownServer);
    if (!this.turn.announcedTools.has(stepIndex)) {
      this.turn.announcedTools.add(stepIndex);
      this.emit('tool.started', { id, ...call });
      if (own) this.emit('tool.called', { id, ...call });
    }
    if (!own || !FINISHED_TOOL_STATES.has(step.state) || this.turn.finishedTools.has(stepIndex)) return;
    this.turn.finishedTools.add(stepIndex);
    const failure = step.tool_info?.error;
    this.emit('tool.completed', {
      id,
      output: failure ? failure.message ?? 'The tool failed' : step.tool_info?.output ?? '',
      isError: Boolean(failure) || step.state === 'ERROR',
    });
  }

  handleResult(result) {
    if (result?.status !== 'SUCCESS') {
      this.completeTurn('failed', AUTH_FAILURE.test(result?.error ?? '') ? NOT_SIGNED_IN : undefined);
      return;
    }
    const deniedActions = result.denied_actions ?? [];
    if (this.turn && !this.turn.answered && deniedActions.length > 0) {
      this.completeTurn('failed', deniedActionsError(deniedActions));
      return;
    }
    if (this.turn && !this.turn.answered && this.turn.refusedTool) {
      this.completeTurn('failed', deniedActionsError([{ action: this.turn.refusedTool }]));
      return;
    }
    if (this.turn && !this.turn.answered && result.response === '' && this.turn.announcedTools.size === 0) {
      this.completeTurn('failed', { type: 'EmptyResponse', message: 'Antigravity ended the turn without an answer.' });
      return;
    }
    this.completeTurn('succeeded');
  }

  handleErrorLine(line) {
    // A turn that ends on a model or agent error prints `AGY_ERROR: {...}` (agy 1.2.6 and later).
    if (this.turn && line.startsWith('AGY_ERROR:')) this.turn.failed = true;
  }

  completeTurn(outcome, error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    const completed = { outcome: turn.failed ? 'failed' : outcome, usage: toEngineUsage(turn.stepUsage) };
    if (error) completed.error = error;
    this.emit('turn.completed', completed);
    this.writeNextPrompt();
  }

  askQuestion({ id, title, questions }) {
    const requestId = crypto.randomUUID();
    this.questions.set(requestId, { hookId: id, questions });
    this.emit('question.requested', {
      requestId,
      title,
      questions: questions.map(({ question, options, multiple }, index) => ({
        id: `q${index}`,
        question,
        options: options.map((label) => ({ label })),
        multiple,
        custom: true,
      })),
    });
  }

  respondQuestion(requestId, answers) {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    this.questions.delete(requestId);
    this.questionHook?.answer(pending.hookId, questionDecision(pending.questions, answers));
  }

  removeToolPlugin() {
    this.questionHook?.stop();
    this.questionHook = null;
    this.toolPlugin?.remove();
    this.toolPlugin = null;
  }

  handleExit(code, signal) {
    this.isAlive = false;
    this.queue = [];
    this.removeToolPlugin();
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
    this.removeToolPlugin();
  }
}

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ClaudeProcess } from './claude-process.js';
import { ClaudeInstaller } from './installer.js';
import { CLAUDE_FALLBACK_CATALOG, readClaudeModels } from './model-catalog.js';
import { createModelCatalog, installedCliIdentity, modelCatalogMethods } from '../model-catalog.js';
import { isString } from '../../shared/guards.js';
import { cliNeedsShell, runCli } from '../cli-platform.js';
import { resolveClaudeExecutable } from './platform.js';

// The Claude Code engine: runs the official `claude` binary in stream-json mode
// and maps its output to the engine events in ../DOCUMENTATION.md.

const runClaude = (args, options) => {
  const { command, isWindows } = resolveClaudeExecutable();
  const shell = isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));
  return spawnSync(command, args, { shell, windowsHide: true, ...options });
};

const readCachedAccount = () => {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) return null;
  try {
    const account = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).oauthAccount;
    if (!account?.emailAddress) return null;
    const orgType = String(account.organizationType || 'pro').toLowerCase();
    const subscriptionType = ['pro', 'team', 'enterprise'].find((type) => orgType.includes(type)) || 'free';
    return { loggedIn: true, email: account.emailAddress, subscriptionType, authMethod: 'claude.ai' };
  } catch {
    return null;
  }
};

const getClaudeAuthStatus = async () => {
  // Reading ~/.claude.json avoids spawning the CLI on every status check.
  const cached = readCachedAccount();
  if (cached) return cached;
  try {
    const res = await runCli(resolveClaudeExecutable(), ['auth', 'status', '--json'], { timeoutMs: 5000 });
    const output = (res.stdout || '').trim();
    if (!output) return { loggedIn: false, reason: 'empty_response' };
    const data = JSON.parse(output);
    return {
      loggedIn: Boolean(data.loggedIn),
      email: data.email || null,
      subscriptionType: data.subscriptionType || 'unknown',
      authMethod: data.authMethod || 'claude.ai',
    };
  } catch (err) {
    return { loggedIn: false, reason: err.message };
  }
};

const claudeLoginProcess = () => {
  const resolved = resolveClaudeExecutable();
  return { command: resolved.command, args: ['auth', 'login'], shell: cliNeedsShell(resolved) };
};

export const logoutClaude = (run = runClaude) => {
  const res = run(['auth', 'logout'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error || res.status !== 0) {
    throw new Error(`claude auth logout did not finish (${res.error?.message || `exit code ${res.status}`}). Run \`claude auth logout\` in a terminal.`);
  }
};

// The result's usage adds up every model call of the turn, and each call
// re-reads the whole conversation, so its counts grow with every tool call.
// The context the turn ends with is what its last call read and wrote.
const toEngineUsage = (usage, lastCall) => {
  if (!usage) return usage;
  const engineUsage = {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    reasoning: usage.thinking_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
  };
  if (lastCall) {
    engineUsage.total = lastCall.input_tokens + lastCall.cache_read_input_tokens
      + lastCall.cache_creation_input_tokens + lastCall.output_tokens;
  }
  return engineUsage;
};

const SIGNED_OUT_RESULT = /Not logged in|Please run \/login|OAuth token has expired/;

const NOT_SIGNED_IN = {
  type: 'AuthRequired',
  message: 'Claude Code is not signed in, so it cannot answer. Run `claude auth login` in a terminal, or sign in from the setup wizard or Settings → Engines, then send the prompt again.',
};

// The CLI reports an API failure as a `success` result with `is_error` set,
// so both mark a failed turn. Its result text is the CLI's own error message.
const toTurnCompleted = (result, lastCall) => {
  const failed = result.subtype !== 'success' || result.isError;
  const usage = toEngineUsage(result.usage, lastCall);
  if (!failed) return { outcome: 'succeeded', usage };
  const message = isString(result.result) && result.result.trim()
    ? result.result.trim()
    : 'Claude Code ended the turn with an error.';
  if (SIGNED_OUT_RESULT.test(message)) return { outcome: 'failed', usage, error: NOT_SIGNED_IN };
  const type = result.subtype && result.subtype !== 'success' ? result.subtype : 'api_error';
  return { outcome: 'failed', usage, error: { type, message } };
};

/**
 * Claude Code names an MCP tool `mcp__<server>__<tool>`. The tool server's
 * own tools are reported by their own names (`openchamber_render`), which is
 * what the chat renders them by; every other tool keeps Claude's name.
 */
const toolNameMapper = (toolServer) => {
  if (!toolServer) return (name) => name;
  const prefix = `mcp__${toolServer.name}__`;
  return (name) => (isString(name) && name.startsWith(prefix) ? name.slice(prefix.length) : name);
};

const ASK_USER_QUESTION = 'AskUserQuestion';
const EXIT_PLAN_MODE = 'ExitPlanMode';

const askUserQuestionSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().optional().catch(undefined),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional().catch(undefined) })).catch([]),
    multiSelect: z.boolean().catch(false).default(false),
  })).min(1),
});

const toEngineQuestions = (questions) => questions.map(({ question, header, options, multiSelect }, index) => ({
  id: `q${index}`,
  header,
  question,
  options,
  multiple: multiSelect,
  custom: true,
}));

const permissionSummary = ({ toolName, input, command }) => (toolName === EXIT_PLAN_MODE && isString(input?.plan) ? input.plan : command);

class ClaudeEngineProcess extends EventEmitter {
  constructor(options) {
    super();
    // Claude keeps the transcript under OpenChamber's session id once it has
    // started one, so every later process resumes it.
    const hasTranscript = options.engineState?.transcript === true;
    const transcriptId = options.engineState?.transcriptId ?? (options.handoff ? crypto.randomUUID() : options.sessionId);
    this.inner = new ClaudeProcess({ ...options, sessionId: transcriptId, resume: hasTranscript || options.resume });
    if (!hasTranscript) {
      const state = transcriptId === options.sessionId ? { transcript: true } : { transcript: true, transcriptId };
      this.inner.once('init', () => this.emit('engine.state', state));
    }
    const toolName = toolNameMapper(options.toolServer);
    this.inner.on('thinking_delta', ({ text }) => this.emit('reasoning.delta', { text }));
    this.inner.on('text_delta', ({ text }) => this.emit('text.delta', { text }));
    this.inner.on('tool_use_start', ({ id, name, input }) => this.emit('tool.started', { id, name: toolName(name), input }));
    this.inner.on('tool_use', ({ id, name, input }) => this.emit('tool.called', { id, name: toolName(name), input }));
    this.inner.on('tool_result', ({ id, output, isError }) => this.emit('tool.completed', { id, output, isError }));
    // The first prompt Claude takes opens a turn; one it takes before that
    // turn's result was folded into it, and that result answers both.
    let turnOpen = false;
    this.inner.on('prompt_consumed', () => {
      if (turnOpen) this.emit('prompt.merged');
      turnOpen = true;
    });
    // The last finished model call of the running turn.
    let lastCall = null;
    this.inner.on('call_usage', (usage) => {
      lastCall = usage;
    });
    this.inner.on('result', (result) => {
      turnOpen = false;
      const turnLastCall = lastCall;
      lastCall = null;
      this.emit('turn.completed', toTurnCompleted(result, turnLastCall));
    });
    this.questions = new Map();
    this.inner.on('control_request', (request) => {
      if (request.subtype !== 'can_use_tool') return;
      if (request.toolName === ASK_USER_QUESTION && this.askQuestion(request)) return;
      this.emit('permission.requested', {
        requestId: request.requestId,
        toolName: toolName(request.toolName),
        input: request.input,
        summary: permissionSummary(request),
      });
    });
    this.inner.on('error', (error) => this.emit('error', error));
    this.inner.on('exit', (info) => this.emit('exit', info));
  }

  get isAlive() {
    return this.inner.isAlive;
  }

  start() {
    return this.inner.start();
  }

  sendUserMessage(text) {
    this.inner.sendUserMessage(text);
  }

  respondPermission(requestId, behavior) {
    this.inner.sendControlResponse(requestId, behavior);
  }

  askQuestion({ requestId, input }) {
    const parsed = askUserQuestionSchema.safeParse(input);
    if (!parsed.success) return false;
    this.questions.set(requestId, { input, questions: parsed.data.questions });
    this.emit('question.requested', { requestId, questions: toEngineQuestions(parsed.data.questions) });
    return true;
  }

  respondQuestion(requestId, answers) {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    this.questions.delete(requestId);
    if (!answers) {
      this.inner.sendPermissionResult(requestId, { behavior: 'deny', message: 'The user dismissed the question without answering.' });
      return;
    }
    const byQuestion = Object.fromEntries(pending.questions.map(({ question }, index) => [question, (answers[`q${index}`] ?? []).join(', ')]));
    this.inner.sendPermissionResult(requestId, { behavior: 'allow', updatedInput: { ...pending.input, answers: byQuestion } });
  }

  setPermissionMode(mode) {
    return this.inner.setPermissionMode(mode);
  }

  abort() {
    return this.inner.abort();
  }
}

export const createClaudeEngine = ({
  installer = new ClaudeInstaller(),
  authStatusProvider = getClaudeAuthStatus,
  readModels = readClaudeModels,
  modelStore = null,
} = {}) => ({
  id: 'claude',
  displayName: 'Claude Code',
  providerID: 'anthropic',
  ...modelCatalogMethods(createModelCatalog({
    id: 'claude',
    read: () => readModels(),
    identify: () => installedCliIdentity(installer),
    fallback: CLAUDE_FALLBACK_CATALOG,
    store: modelStore,
  })),
  // Claude Code 2.1.301 resolves the aliases to claude-sonnet-5-5,
  // claude-opus-5-5 and claude-haiku-5-5, and its own model table gives each a
  // native 1M context window and 128K output tokens.
  limit: { context: 1_000_000, output: 128_000 },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  permissionModes: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  defaultPermissionMode: 'auto',
  permissionModeTiers: {
    plan: 'read',
    manual: 'ask',
    dontAsk: 'ask',
    acceptEdits: 'edits',
    auto: 'auto',
    bypassPermissions: 'full',
  },
  // A running Claude takes these through a `set_permission_mode` control
  // request. It refuses bypass unless the process was launched in it, so
  // bypass waits for the next process.
  livePermissionModes: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'],
  dangerousPermissionModes: ['bypassPermissions'],
  installer,
  auth: {
    status: authStatusProvider,
    loginProcess: claudeLoginProcess,
    logout: () => logoutClaude(),
    loginCommand: 'claude auth login',
    logoutCommand: 'claude auth logout',
  },
  createProcess: (options) => new ClaudeEngineProcess(options),
});

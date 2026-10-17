import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProcess } from './claude-process.js';
import { ClaudeInstaller } from './installer.js';
import { isString } from '../../shared/guards.js';
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
    const res = runClaude(['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const startClaudeLogin = () => {
  // The CLI opens the browser and waits for the OAuth callback, so it must not block the request.
  const { command, isWindows } = resolveClaudeExecutable();
  const shell = isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));
  const child = spawn(command, ['auth', 'login', '--claudeai'], { detached: true, stdio: 'ignore', shell, windowsHide: false });
  child.unref();
};

const logoutClaude = () => {
  runClaude(['auth', 'logout'], { encoding: 'utf8', timeout: 5000 });
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

// The CLI reports an API failure as a `success` result with `is_error` set,
// so both mark a failed turn. Its result text is the CLI's own error message.
const toTurnCompleted = (result, lastCall) => {
  const failed = result.subtype !== 'success' || result.isError;
  const usage = toEngineUsage(result.usage, lastCall);
  if (!failed) return { outcome: 'succeeded', usage };
  const message = isString(result.result) && result.result.trim()
    ? result.result.trim()
    : 'Claude Code ended the turn with an error.';
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

class ClaudeEngineProcess extends EventEmitter {
  constructor(options) {
    super();
    // Claude keeps the transcript under OpenChamber's session id once it has
    // started one, so every later process resumes it.
    const hasTranscript = options.engineState?.transcript === true;
    this.inner = new ClaudeProcess({ ...options, resume: hasTranscript || options.resume });
    if (!hasTranscript) {
      this.inner.once('init', () => this.emit('engine.state', { transcript: true }));
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
    this.inner.on('control_request', (request) => {
      if (request.subtype !== 'can_use_tool') return;
      this.emit('permission.requested', {
        requestId: request.requestId,
        toolName: toolName(request.toolName),
        input: request.input,
        summary: request.command,
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

  abort() {
    return this.inner.abort();
  }
}

// Aliases: the CLI resolves each one to the newest model of that family.
const CLAUDE_MODEL_CATALOG = {
  models: [
    { id: 'sonnet', name: 'Claude Sonnet', family: 'claude-sonnet' },
    { id: 'opus', name: 'Claude Opus', family: 'claude-opus' },
    { id: 'haiku', name: 'Claude Haiku', family: 'claude-haiku' },
  ],
  defaultModel: 'sonnet',
};

export const createClaudeEngine = ({ installer = new ClaudeInstaller(), authStatusProvider = getClaudeAuthStatus } = {}) => ({
  id: 'claude',
  displayName: 'Claude Code',
  providerID: 'anthropic',
  modelCatalog: () => CLAUDE_MODEL_CATALOG,
  // Claude Code 2.1.301 resolves the aliases to claude-sonnet-5-5,
  // claude-opus-5-5 and claude-haiku-5-5, and its own model table gives each a
  // native 1M context window and 128K output tokens.
  limit: { context: 1_000_000, output: 128_000 },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  permissionModes: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  defaultPermissionMode: 'auto',
  installer,
  auth: {
    status: authStatusProvider,
    login: startClaudeLogin,
    logout: logoutClaude,
    loginCommand: 'claude auth login',
  },
  createProcess: (options) => new ClaudeEngineProcess(options),
});

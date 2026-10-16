import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProcess } from './claude-process.js';
import { ClaudeInstaller } from './installer.js';
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

const toEngineUsage = (usage) => usage && {
  input: usage.input_tokens || 0,
  output: usage.output_tokens || 0,
  reasoning: usage.thinking_tokens || 0,
  cacheRead: usage.cache_read_input_tokens || 0,
  cacheWrite: usage.cache_creation_input_tokens || 0,
};

class ClaudeEngineProcess extends EventEmitter {
  constructor(options) {
    super();
    this.inner = new ClaudeProcess(options);
    this.inner.on('thinking_delta', ({ text }) => this.emit('reasoning.delta', { text }));
    this.inner.on('text_delta', ({ text }) => this.emit('text.delta', { text }));
    this.inner.on('tool_use_start', ({ id, name, input }) => this.emit('tool.started', { id, name, input }));
    this.inner.on('control_request', (request) => {
      if (request.subtype !== 'can_use_tool') return;
      this.emit('permission.requested', {
        requestId: request.requestId,
        toolName: request.toolName,
        input: request.input,
        summary: request.command,
      });
    });
    this.inner.on('result', (result) => this.emit('turn.completed', {
      outcome: result.subtype === 'success' ? 'succeeded' : 'failed',
      usage: toEngineUsage(result.usage),
    }));
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

export const createClaudeEngine = ({ installer = new ClaudeInstaller(), authStatusProvider = getClaudeAuthStatus } = {}) => ({
  id: 'claude',
  displayName: 'Claude Code',
  providerID: 'anthropic',
  // Aliases: the CLI resolves each one to the newest model of that family.
  models: [
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'opus', name: 'Claude Opus' },
    { id: 'haiku', name: 'Claude Haiku' },
  ],
  defaultModel: 'sonnet',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  permissionModes: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  defaultPermissionMode: 'auto',
  installer,
  auth: {
    status: authStatusProvider,
    login: startClaudeLogin,
    logout: logoutClaude,
  },
  createProcess: (options) => new ClaudeEngineProcess(options),
});

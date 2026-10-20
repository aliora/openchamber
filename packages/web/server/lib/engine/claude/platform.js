import path from 'node:path';
import { resolveCliExecutable, resolveCliExecutableAsync, spawnCli, terminateChild } from '../cli-platform.js';

const CLAUDE_BINARY = {
  binary: 'claude',
  // The npm package's direct .exe comes first: it skips the cmd.exe wrapper.
  windowsCandidates: (env) => [
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : null,
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'claude.cmd') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.cmd') : null,
  ].filter(Boolean),
  unixCandidates: (env) => [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    env.HOME ? path.join(env.HOME, '.local', 'bin', 'claude') : null,
    env.HOME ? path.join(env.HOME, '.npm-global', 'bin', 'claude') : null,
  ].filter(Boolean),
};

export const resolveClaudeExecutable = (options = {}) => resolveCliExecutable(CLAUDE_BINARY, options);

export const resolveClaudeExecutableAsync = (options = {}) => resolveCliExecutableAsync(CLAUDE_BINARY, options);

export const spawnClaudeProcess = (args, options = {}) => {
  const resolved = resolveClaudeExecutable({ platform: options.platform, env: options.env });
  return spawnCli(resolved, args, { cwd: options.cwd, env: options.env });
};

export const terminateClaudeProcess = terminateChild;

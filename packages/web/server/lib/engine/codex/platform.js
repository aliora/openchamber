import path from 'node:path';
import { cliNeedsShell, resolveCliExecutable, runCli, spawnCli } from '../cli-platform.js';

// Finding and starting the `codex` binary. The npm package installs a Node
// launcher (`codex.cmd` on Windows) that picks the native binary for the
// platform and puts its bundled tools on PATH, so the launcher is what runs.

const CODEX_BINARY = {
  binary: 'codex',
  windowsCandidates: (env) => [
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'codex.cmd') : null,
  ].filter(Boolean),
  unixCandidates: (env) => [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
    env.HOME ? path.join(env.HOME, '.local', 'bin', 'codex') : null,
    env.HOME ? path.join(env.HOME, '.npm-global', 'bin', 'codex') : null,
  ].filter(Boolean),
};

export const resolveCodexExecutable = (options = {}) => resolveCliExecutable(CODEX_BINARY, options);

/** Starts `codex <args>` with piped stdio in `options.cwd`. */
export const spawnCodexProcess = (args, options = {}) => spawnCli(resolveCodexExecutable(), args, options);

/** Runs a short `codex` command, such as `login status`, and resolves with its output. */
export const runCodexCommand = (args, options = {}) => runCli(resolveCodexExecutable(), args, options);

/** The device-code sign-in, which prints a link and a one-time code and finishes by itself. */
export const codexLoginProcess = () => {
  const resolved = resolveCodexExecutable();
  return { command: resolved.command, args: ['login', '--device-auth'], shell: cliNeedsShell(resolved) };
};

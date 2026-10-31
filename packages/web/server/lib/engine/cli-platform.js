import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { inAgentScope } from './agent-scope.js';

// Finding, starting and stopping a coding CLI binary, shared by every engine.
// Each engine passes its binary name and the install locations it knows.

/**
 * Resolves `binary` to `{ command, isWindows }`. Windows checks the engine's
 * known install paths, then `where.exe` (an `.exe` before a `.cmd` wrapper);
 * macOS and Linux check the known paths, then the login shell's PATH. Falls
 * back to the bare name so a spawn still reports ENOENT instead of throwing here.
 */
export const resolveCliExecutable = (spec, options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;

  if (targetPlatform === 'win32') {
    const known = spec.windowsCandidates(env).find((candidate) => fs.existsSync(candidate));
    if (known) return { command: known, isWindows: true };

    try {
      const where = spawnSync('where.exe', [spec.binary], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const found = pickWhereMatch(where.stdout);
      if (found) return { command: found, isWindows: true };
    } catch {
      // where.exe is missing or timed out: fall back to the wrapper name.
    }

    return { command: `${spec.binary}.cmd`, isWindows: true };
  }

  const known = spec.unixCandidates(env).find((candidate) => fs.existsSync(candidate));
  if (known) return { command: known, isWindows: false };

  try {
    const which = spawnSync(loginShell(targetPlatform, env), ['-lic', `command -v ${spec.binary}`], {
      encoding: 'utf8',
      timeout: 3000,
      env,
    });
    const resolved = lastWord(which.stdout);
    if (resolved && fs.existsSync(resolved)) {
      return { command: resolved, isWindows: false };
    }
  } catch {
    // The login shell failed: fall back to the bare name.
  }

  return { command: spec.binary, isWindows: false };
};

/**
 * `resolveCliExecutable` without blocking the event loop: the `where.exe` and
 * login-shell lookups run as child processes the caller awaits.
 */
export const resolveCliExecutableAsync = async (spec, options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;

  if (targetPlatform === 'win32') {
    const known = spec.windowsCandidates(env).find((candidate) => fs.existsSync(candidate));
    if (known) return { command: known, isWindows: true };

    const where = await runCli({ command: 'where.exe', isWindows: true }, [spec.binary], { timeoutMs: 3000 });
    return { command: pickWhereMatch(where.stdout) ?? `${spec.binary}.cmd`, isWindows: true };
  }

  const known = spec.unixCandidates(env).find((candidate) => fs.existsSync(candidate));
  if (known) return { command: known, isWindows: false };

  const which = await runCli({ command: loginShell(targetPlatform, env), isWindows: false }, ['-lic', `command -v ${spec.binary}`], { timeoutMs: 3000, env });
  const resolved = lastWord(which.stdout);
  return { command: resolved && fs.existsSync(resolved) ? resolved : spec.binary, isWindows: false };
};

const loginShell = (platform, env) => env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

const lastWord = (output) => (output || '').trim().split(/\s+/).pop();

const pickWhereMatch = (output) => {
  const candidates = (output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((line) => line.toLowerCase().endsWith('.exe'))
    ?? candidates.find((line) => line.toLowerCase().endsWith('.cmd') || line.toLowerCase().endsWith('.bat'))
    ?? null;
};

/** A `.cmd` or `.bat` wrapper only runs through cmd.exe. */
export const cliNeedsShell = ({ command, isWindows }) => isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));

export const shellCommand = (command, shell) => (shell && /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command);

export const spawnCli = (resolved, args, options = {}) => {
  const [command, scopedArgs] = inAgentScope(shellCommand(resolved.command, cliNeedsShell(resolved)), args);
  return spawn(command, scopedArgs, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env },
    shell: cliNeedsShell(resolved),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

/**
 * Runs a short CLI command and resolves with its exit code and output. Never
 * rejects: a spawn failure resolves with `code: null` and the error message.
 */
export const runCli = (resolved, args, options = {}) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  const child = spawn(shellCommand(resolved.command, cliNeedsShell(resolved)), args, {
    env: { ...process.env, ...options.env },
    shell: cliNeedsShell(resolved),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ code: null, stdout, stderr, error: 'timed out' });
  }, options.timeoutMs || 5000);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
  child.on('close', (code) => finish({ code, stdout, stderr, error: null }));
});

/** Stops a CLI child: SIGINT first, then a forced kill after `timeoutMs`. */
export const terminateChild = async (child, timeoutMs = 2500) => {
  if (!child || child.killed || child.exitCode !== null) return;

  const isWin = process.platform === 'win32';

  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    child.once('exit', cleanup);

    try {
      child.kill('SIGINT');
    } catch {
      // The child is already gone.
    }

    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        if (isWin && child.pid) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              timeout: 2000,
            });
          } catch {
            // taskkill failed: nothing more to try.
          }
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child is already gone.
          }
        }
      }
      cleanup();
    }, timeoutMs);
  });
};

const readProcessTable = () => {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  if (listed.status !== 0) return new Map();
  const parents = new Map();
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, ppid);
  }
  return parents;
};

const descendantsOf = (rootPid, parents) => {
  const found = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  found.delete(rootPid);
  return found;
};

export const terminateChildTree = async (child, {
  timeoutMs,
  platform = process.platform,
  readParents = readProcessTable,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) => {
  if (platform === 'win32' || !child?.pid) return terminateChild(child, timeoutMs);
  const tree = descendantsOf(child.pid, readParents());
  await terminateChild(child, timeoutMs);
  if (tree.size === 0) return;
  for (const [pid, ppid] of readParents()) {
    if (!tree.has(pid) || !(ppid === 1 || tree.has(ppid))) continue;
    try {
      kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') console.warn(`[engine] Could not stop process ${pid} left by a stopped CLI:`, error.message);
    }
  }
};

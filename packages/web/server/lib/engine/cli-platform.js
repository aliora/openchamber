import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

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
      if (where.stdout) {
        const candidates = where.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const exeFound = candidates.find((s) => s.toLowerCase().endsWith('.exe'));
        if (exeFound) return { command: exeFound, isWindows: true };
        const cmdFound = candidates.find((s) => s.toLowerCase().endsWith('.cmd') || s.toLowerCase().endsWith('.bat'));
        if (cmdFound) return { command: cmdFound, isWindows: true };
      }
    } catch {
      // where.exe is missing or timed out: fall back to the wrapper name.
    }

    return { command: `${spec.binary}.cmd`, isWindows: true };
  }

  const known = spec.unixCandidates(env).find((candidate) => fs.existsSync(candidate));
  if (known) return { command: known, isWindows: false };

  try {
    const shell = env.SHELL || (targetPlatform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const which = spawnSync(shell, ['-lic', `command -v ${spec.binary}`], {
      encoding: 'utf8',
      timeout: 3000,
      env,
    });
    const resolved = (which.stdout || '').trim().split(/\s+/).pop();
    if (resolved && fs.existsSync(resolved)) {
      return { command: resolved, isWindows: false };
    }
  } catch {
    // The login shell failed: fall back to the bare name.
  }

  return { command: spec.binary, isWindows: false };
};

/** A `.cmd` or `.bat` wrapper only runs through cmd.exe. */
export const cliNeedsShell = ({ command, isWindows }) => isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));

export const shellCommand = (command, shell) => (shell && /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command);

export const spawnCli = (resolved, args, options = {}) => spawn(shellCommand(resolved.command, cliNeedsShell(resolved)), args, {
  cwd: options.cwd || process.cwd(),
  env: { ...process.env, ...options.env },
  shell: cliNeedsShell(resolved),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

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

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Finding, starting and stopping the `agy` binary. The official installer puts
// a native executable at ~/.local/bin/agy on macOS and Linux and at
// %LOCALAPPDATA%\agy\bin\agy.exe on Windows. It is never a .cmd wrapper, so
// agy always starts without a shell.

const OUTPUT_LIMIT = 1024 * 1024;

const lookupOnPath = (platform, env) => {
  try {
    if (platform === 'win32') {
      const where = spawnSync('where.exe', ['agy'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return (where.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.toLowerCase().endsWith('.exe')) || null;
    }
    // A login shell sees the PATH line the installer adds to the shell profile.
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const which = spawnSync(shell, ['-lic', 'command -v agy'], { encoding: 'utf8', timeout: 3000, env });
    return (which.stdout || '').trim().split(/\s+/).pop() || null;
  } catch {
    return null;
  }
};

/**
 * Returns `{ command }`: an absolute path when agy was found, otherwise the bare
 * name so the spawn fails with ENOENT and the caller reports "not installed".
 */
export const resolveAgyExecutable = ({
  platform = process.platform,
  env = process.env,
  fileExists = fs.existsSync,
  lookup = lookupOnPath,
} = {}) => {
  const candidates = platform === 'win32'
    ? [env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')]
    : [env.HOME && path.posix.join(env.HOME, '.local', 'bin', 'agy'), '/usr/local/bin/agy'];

  const installed = candidates.find((candidate) => candidate && fileExists(candidate));
  if (installed) return { command: installed };

  const found = lookup(platform, env);
  if (found && fileExists(found)) return { command: found };

  return { command: 'agy' };
};

export const spawnAgyProcess = (args, { cwd = process.cwd(), env = process.env } = {}) => {
  const { command } = resolveAgyExecutable();
  return spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
};

/**
 * Runs a short agy subcommand and collects stdout. Stdin is closed on purpose:
 * agy before 1.1.21 waited on an open stdin pipe for subcommands such as `models`.
 */
export const runAgy = (args, { timeoutMs = 10000 } = {}) => new Promise((resolve) => {
  const { command } = resolveAgyExecutable();
  let stdout = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ exitCode: null, stdout, error: new Error(`agy ${args.join(' ')} timed out`) });
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
  });
  child.on('error', (error) => finish({ exitCode: null, stdout, error }));
  child.on('close', (exitCode) => finish({ exitCode, stdout, error: null }));
});

const forceKill = (child, platform) => {
  try {
    if (platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // The process is already gone.
  }
};

/** Interrupts agy like Ctrl+C, then kills it when it has not exited after `timeoutMs`. */
export const terminateAgyProcess = (child, { timeoutMs = 2500, platform = process.platform } = {}) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      forceKill(child, platform);
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGINT');
    } catch {
      // The exit listener or the timer settles the promise.
    }
  });
};

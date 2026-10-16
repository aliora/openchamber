import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const normalizeFsPath = (rawPath) => {
  if (typeof rawPath !== 'string') return '';
  return rawPath.replace(/\\/g, '/');
};

export const resolveClaudeExecutable = (options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;

  if (targetPlatform === 'win32') {
    // 1. Check APPDATA npm global location
    if (env.APPDATA) {
      const npmGlobal = path.join(env.APPDATA, 'npm', 'claude.cmd');
      if (fs.existsSync(npmGlobal)) {
        return { command: npmGlobal, isWindows: true };
      }
    }

    // 2. Check LOCALAPPDATA Programs location
    if (env.LOCALAPPDATA) {
      const localProg = path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.cmd');
      if (fs.existsSync(localProg)) {
        return { command: localProg, isWindows: true };
      }
    }

    // 3. Try where.exe
    try {
      const where = spawnSync('where.exe', ['claude'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (where.stdout) {
        const found = where.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s.endsWith('.cmd') || s.endsWith('.exe') || s.endsWith('.bat'));
        if (found) {
          return { command: found, isWindows: true };
        }
      }
    } catch {
      // Ignore where.exe failure
    }

    return { command: 'claude.cmd', isWindows: true };
  }

  // macOS / Linux resolution
  const commonPaths = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    env.HOME ? path.join(env.HOME, '.local', 'bin', 'claude') : null,
    env.HOME ? path.join(env.HOME, '.npm-global', 'bin', 'claude') : null,
  ].filter(Boolean);

  for (const candidate of commonPaths) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, isWindows: false };
    }
  }

  // Fallback to checking login shell
  try {
    const shell = env.SHELL || (targetPlatform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const which = spawnSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 3000,
      env,
    });
    const resolved = (which.stdout || '').trim().split(/\s+/).pop();
    if (resolved && fs.existsSync(resolved)) {
      return { command: resolved, isWindows: false };
    }
  } catch {
    // Ignore shell resolution failure
  }

  return { command: 'claude', isWindows: false };
};

export const spawnClaudeProcess = (args, options = {}) => {
  const { command, isWindows } = resolveClaudeExecutable({
    platform: options.platform,
    env: options.env,
  });

  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };

  return spawn(command, args, {
    cwd,
    env,
    shell: isWindows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

export const terminateClaudeProcess = async (child, timeoutMs = 2500) => {
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

    // Try graceful SIGINT first
    try {
      child.kill('SIGINT');
    } catch {
      // Ignore
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
            // Ignore
          }
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
      }
      cleanup();
    }, timeoutMs);
  });
};

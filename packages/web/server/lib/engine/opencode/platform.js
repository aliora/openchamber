import { access } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readEnterprisePolicy } from '../../enterprise-mode.js';

const execute = promisify(execFile);

/** Stops only the tree we spawned, never a process located by port. */
export const stopOpenCodeChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
  } else {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 2500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
};

export const resolveOpenCodeExecutable = async ({ env = process.env, platform = process.platform, readPolicy = readEnterprisePolicy } = {}) => {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const windows = platform === 'win32';
  const pinned = readPolicy().opencodeBinary;
  if (pinned) {
    try { await access(pinned); } catch { throw new Error('The OpenCode CLI pinned by your administrator is unavailable.'); }
    return { command: pinned, isWindows: windows };
  }
  const candidates = [env.OPENCODE_BINARY, env.OPENCODE_PATH, env.OPENCHAMBER_OPENCODE_PATH,
    path.join(home, '.opencode', 'bin', windows ? 'opencode.exe' : 'opencode'),
    windows && env.APPDATA ? path.join(env.APPDATA, 'npm', 'opencode.cmd') : null,
    ...(!windows ? ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', path.join(home, '.local/bin/opencode')] : []),
  ].filter(Boolean);
  for (const command of candidates) {
    try { await access(command); return { command, isWindows: windows }; } catch { /* Try the next known path. */ }
  }
  const lookup = windows
    ? await execute('where.exe', ['opencode'], { env, windowsHide: true, timeout: 5000 }).catch(() => null)
    : await execute(env.SHELL || '/bin/sh', ['-lc', 'command -v opencode'], { env, timeout: 5000 }).catch(() => null);
  const command = lookup?.stdout.trim().split(/\r?\n/)[0];
  if (!command) throw new Error('OpenCode CLI not found. Install @opencode/cli or configure its binary path.');
  return { command, isWindows: windows };
};

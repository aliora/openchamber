import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };

type OwnedSpawnOptions = Pick<SpawnOptions, 'cwd' | 'env'>;

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const closesWithin = async (closed: Promise<unknown>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Windows stop: taskkill /F ends OpenCode before it records how its running
 * turns ended, so a chat waiting on a question reopens stuck (#5129). A child
 * holding a stdin lease (`opencode serve --stdio`) gets EOF first and up to
 * `stdinLeaseGraceMs` to exit on its own; the tree kill runs only if it is
 * still alive. Mirrors the web server's managed-process-stop.js, whose kill is
 * synchronous and waits 3 more seconds; here the kill is awaited so its
 * failure stays an error, and the whole stop fits VS Code's 5 second
 * deactivation budget.
 */
export async function stopWindowsProcessTree(
  child: ChildProcess,
  closed: Promise<unknown>,
  { stdinLeaseGraceMs, killTree }: { stdinLeaseGraceMs?: number; killTree: (pid: number) => Promise<void> },
) {
  if (stdinLeaseGraceMs !== undefined && isRunning(child) && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
    await closesWithin(closed, stdinLeaseGraceMs);
  }
  // Keep the parent alive until Windows has enumerated its descendants.
  if (isRunning(child) && child.pid) await killTree(child.pid);
}

const taskkillTree = (child: ChildProcess) => (pid: number) => new Promise<void>((resolve, reject) => {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true, timeout: 5000,
  }, (error) => {
    if (error && isRunning(child)) reject(error);
    else resolve();
  });
});

// Each background command gets its own POSIX group. Never signal the extension
// host's group, which can also contain unrelated extensions and editor work.
export function spawnOwnedProcess(binary: string, args: string[], options: OwnedSpawnOptions) {
  return own(spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  }));
}

/** The same ownership, plus a Node IPC channel to the child (`process.send` there). */
export function spawnOwnedIpcProcess(binary: string, args: string[], options: OwnedSpawnOptions) {
  return own(spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  }));
}

function own<Child extends ChildProcess>(child: Child) {
  let spawnError: Error | null = null;
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  const waitForClose = (timeoutMs: number) => closesWithin(closed, timeoutMs);
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  let termination: Promise<void> | null = null;
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      if (!child.pid) { await closed; return; }
      if (process.platform === 'win32') {
        await stopWindowsProcessTree(child, closed, { killTree: taskkillTree(child) });
      } else {
        signalGroup('SIGTERM');
        await waitForClose(1000);
        // A parent can exit while a tool ignores SIGTERM or holds its pipes.
        signalGroup('SIGKILL');
      }
      if (!await waitForClose(1000)) throw new Error('Owned process did not close after termination');
    })();
    return termination;
  };
  return { child, closed, waitForClose, terminate };
}

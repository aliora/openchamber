import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// An OpenChamber server that runs as a systemd unit shares the unit's cgroup
// with every CLI it spawns, and stopping or restarting the unit kills them all
// mid-turn. On Linux under systemd each CLI therefore starts in a transient
// scope of its own (`systemd-run --user --scope`): a restart leaves it running,
// it finishes the work in hand, and it exits once it reads the end of its
// stdin. Its pipes died with the old server, so no later server can reattach to
// it. What a restarted server has to do is stop such a leftover before it
// starts a new CLI for the same session, so two processes never write one
// transcript. Elsewhere, or when systemd-run is not usable, CLIs spawn as they
// always did.

const SCOPE_ARGS = ['--user', '--scope', '--quiet', '--collect'];

const scopeAvailable = ({ platform, env, run }) => {
  if (platform !== 'linux' || !env.INVOCATION_ID) return false;
  try {
    return run('systemd-run', [...SCOPE_ARGS, 'true'], { stdio: 'ignore', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
};

/** `[command, args]` for a CLI that should outlive a restart of the server's systemd unit. */
export const createAgentScope = ({ platform = process.platform, env = process.env, run = spawnSync } = {}) => {
  let available = null;
  return (command, args) => {
    available ??= scopeAvailable({ platform, env, run });
    return available ? ['systemd-run', [...SCOPE_ARGS, '--', command, ...args]] : [command, args];
  };
};

export const inAgentScope = createAgentScope();

/**
 * A process's identity on Linux: the boot and its start time in clock ticks,
 * so a pid the kernel has since given to another process does not match. Null
 * when the process is gone or the platform has no /proc.
 */
const readLinuxProcessIdentity = (pid) => {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name; the start time is field 22.
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return startTicks ? `${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
};

const LEFTOVER_EXIT_WAIT_MS = 5000;
const LEFTOVER_POLL_MS = 100;

/**
 * The CLI processes this server started, by session, in a file the next
 * server reads. Only processes with a readable identity are kept, which is
 * Linux, the one platform where they outlive the server.
 */
export const createAgentProcessRegistry = ({
  file,
  readIdentity = readLinuxProcessIdentity,
  signal = (pid, name) => process.kill(pid, name),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exitWaitMs = LEFTOVER_EXIT_WAIT_MS,
}) => {
  let writes = Promise.resolve();

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };

  // Writes run one after another, each on the file the previous one left.
  const update = (change) => {
    writes = writes.then(() => {
      const entries = read();
      change(entries);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entries));
    }).catch((error) => {
      console.warn('[engine] Could not update the agent process list:', error.message);
    });
    return writes;
  };

  const isRunning = ({ pid, identity }) => readIdentity(pid) === identity;

  const waitForExit = async (entry, timeoutMs) => {
    for (let waited = 0; waited < timeoutMs; waited += LEFTOVER_POLL_MS) {
      if (!isRunning(entry)) return true;
      await sleep(LEFTOVER_POLL_MS);
    }
    return !isRunning(entry);
  };

  const send = (pid, name) => {
    try {
      signal(pid, name);
    } catch {
      // Gone between the check and the signal.
    }
  };

  return {
    record(sessionId, pid) {
      const identity = pid ? readIdentity(pid) : null;
      if (!identity) return writes;
      return update((entries) => {
        entries[sessionId] = { pid, identity };
      });
    },

    forget(sessionId, pid) {
      return update((entries) => {
        if (entries[sessionId]?.pid === pid) delete entries[sessionId];
      });
    },

    /**
     * Stops the session's CLI left running by an earlier server, if there is
     * one: SIGINT, which lets the CLI save its transcript, then SIGKILL when it
     * has not exited after `exitWaitMs`.
     */
    async stopLeftover(sessionId) {
      await writes;
      const entry = read()[sessionId];
      if (!entry) return;
      if (isRunning(entry)) {
        console.warn(`[engine] Stopping the CLI an earlier server left running for session ${sessionId} (pid ${entry.pid})`);
        send(entry.pid, 'SIGINT');
        if (!await waitForExit(entry, exitWaitMs)) {
          send(entry.pid, 'SIGKILL');
          await waitForExit(entry, 1000);
        }
      }
      await update((entries) => {
        if (entries[sessionId]?.pid === entry.pid) delete entries[sessionId];
      });
    },
  };
};

import os from 'node:os';
import { spawnAgyProcess } from './platform.js';

const PROBE_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'auto'];
const UNAVAILABLE_WARNING = /--mode auto is not available/;
const INIT_EVENT = /"event"\s*:\s*"init"/;

/**
 * Whether the signed-in agy account has auto mode. agy started in auto mode
 * with stdin closed opens a session and exits without a turn, so no model is
 * called. An account without auto mode makes agy warn on stderr and run in its
 * default mode. Anything but a clean start without that warning answers false.
 */
export const probeAgyAutoMode = ({ spawnProcess = spawnAgyProcess, cwd = os.tmpdir(), timeoutMs = 20_000 } = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawnProcess(PROBE_ARGS, { cwd });
  } catch {
    resolve(false);
    return;
  }
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const finish = (available) => {
    clearTimeout(timer);
    resolve(available);
  };
  child.on('error', () => finish(false));
  child.on('close', (code) => finish(code === 0 && INIT_EVENT.test(stdout) && !UNAVAILABLE_WARNING.test(stderr)));
  child.stdin.on('error', () => {});
  child.stdin.end();
});

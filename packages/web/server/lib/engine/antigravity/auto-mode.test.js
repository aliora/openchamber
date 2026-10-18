import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { probeAgyAutoMode } from './auto-mode.js';

const INIT = '{"event":"init","conversation_id":"e8dfaefd-87cf-4903-a47c-cfd6179994b8","init":{"cwd":"/tmp","permission_mode":"request-review"}}\n';
const UNAVAILABLE = 'warning: --mode auto is not available for this account; continuing in the default mode.\n';

const createFakeChild = () => {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: [],
    kill: (signal) => child.killed.push(signal),
  });
  return child;
};

const answering = ({ stdout = '', stderr = '', code = 0 }) => {
  const spawned = [];
  const spawnProcess = (args, options) => {
    const child = createFakeChild();
    spawned.push({ args, options, child });
    child.stdin.on('finish', () => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setTimeout(() => child.emit('close', code), 5);
    });
    return child;
  };
  return { spawned, spawnProcess };
};

describe('probeAgyAutoMode', () => {
  it('starts agy in auto mode with stdin closed, so no prompt is sent', async () => {
    const { spawned, spawnProcess } = answering({ stdout: INIT });
    expect(await probeAgyAutoMode({ spawnProcess })).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'auto']);
    expect(spawned[0].child.stdin.writableFinished).toBe(true);
  });

  it('answers false when agy warns that the account has no auto mode', async () => {
    const { spawnProcess } = answering({ stdout: INIT, stderr: UNAVAILABLE });
    expect(await probeAgyAutoMode({ spawnProcess })).toBe(false);
  });

  it('answers false when agy did not start a session or failed', async () => {
    expect(await probeAgyAutoMode(answering({ stdout: '' }))).toBe(false);
    expect(await probeAgyAutoMode(answering({ stdout: INIT, code: 1 }))).toBe(false);
    expect(await probeAgyAutoMode({
      spawnProcess: () => {
        throw new Error('spawn agy ENOENT');
      },
    })).toBe(false);
  });

  it('answers false when agy fails to spawn', async () => {
    const spawnProcess = () => {
      const child = createFakeChild();
      setTimeout(() => {
        child.emit('error', new Error('spawn agy ENOENT'));
        child.emit('close', -2);
      }, 5);
      return child;
    };
    expect(await probeAgyAutoMode({ spawnProcess })).toBe(false);
  });

  it('kills an agy that does not exit and answers false', async () => {
    const child = createFakeChild();
    const result = probeAgyAutoMode({ spawnProcess: () => child, timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.killed).toEqual(['SIGKILL']);
    child.emit('close', null);
    expect(await result).toBe(false);
  });
});

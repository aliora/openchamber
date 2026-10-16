import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { resolveAgyExecutable, terminateAgyProcess } from './platform.js';

const existing = (...paths) => (candidate) => paths.includes(candidate);
const noLookup = () => null;

describe('resolveAgyExecutable', () => {
  it('finds the binary where the official installer puts it', () => {
    expect(resolveAgyExecutable({
      platform: 'linux',
      env: { HOME: '/home/dev' },
      fileExists: existing('/home/dev/.local/bin/agy'),
      lookup: noLookup,
    })).toEqual({ command: '/home/dev/.local/bin/agy' });

    expect(resolveAgyExecutable({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      fileExists: existing('C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe'),
      lookup: noLookup,
    })).toEqual({ command: 'C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe' });
  });

  it('falls back to the PATH lookup, then to the bare name', () => {
    expect(resolveAgyExecutable({
      platform: 'darwin',
      env: { HOME: '/Users/dev' },
      fileExists: existing('/opt/homebrew/bin/agy'),
      lookup: () => '/opt/homebrew/bin/agy',
    })).toEqual({ command: '/opt/homebrew/bin/agy' });

    expect(resolveAgyExecutable({
      platform: 'darwin',
      env: { HOME: '/Users/dev' },
      fileExists: () => false,
      lookup: () => '/gone/agy',
    })).toEqual({ command: 'agy' });
  });
});

describe('terminateAgyProcess', () => {
  const createChild = ({ exitsOn }) => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, pid: 4242, signals: [] });
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === exitsOn) queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    return child;
  };

  it('interrupts agy and resolves once it exits', async () => {
    const child = createChild({ exitsOn: 'SIGINT' });
    await terminateAgyProcess(child, { platform: 'linux' });
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('kills agy that ignores the interrupt', async () => {
    const child = createChild({ exitsOn: 'SIGKILL' });
    await terminateAgyProcess(child, { timeoutMs: 10, platform: 'linux' });
    expect(child.signals).toEqual(['SIGINT', 'SIGKILL']);
  });

  it('does nothing for a process that already exited', async () => {
    const child = createChild({ exitsOn: 'SIGINT' });
    child.exitCode = 0;
    await terminateAgyProcess(child);
    expect(child.signals).toEqual([]);
  });
});

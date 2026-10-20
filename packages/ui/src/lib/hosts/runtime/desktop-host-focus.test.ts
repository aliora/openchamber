import { describe, expect, test } from 'bun:test';

import { OpencodeService } from '@/lib/opencode/client';
import { desktopHostIdOf, persistFocusedDesktopHost } from './desktop-host-focus';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import type { HostRegistry } from './types';

const createRegistry = (): HostRegistry => createHostRegistry(() => {
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: async () => new Response(null, { status: 404 }),
    createTunnel: () => { throw new Error('no tunnels here'); },
  });
  return { transport, client: new OpencodeService({ transport, runtimeKey: () => 'unused' }) };
});

const register = (registry: HostRegistry, runtimeKey: string): void => {
  registry.register({
    descriptor: { id: runtimeKey, label: runtimeKey, kind: 'direct', displayUrl: 'https://host.example/', runtimeKey, monitored: true },
    endpoint: { kind: 'direct', apiUrl: 'https://host.example' },
  }, async () => null);
};

const manualTimers = () => {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    schedule: (run: () => void) => {
      const id = next++;
      pending.set(id, run);
      return () => { pending.delete(id); };
    },
    flush: () => {
      for (const [id, run] of [...pending]) {
        pending.delete(id);
        run();
      }
    },
    size: () => pending.size,
  };
};

describe('desktopHostIdOf', () => {
  test('maps the desktop runtime keys back to saved host ids', () => {
    expect(desktopHostIdOf('local')).toBe('local');
    expect(desktopHostIdOf('host:host-pi5')).toBe('host-pi5');
    expect(desktopHostIdOf('host:')).toBeNull();
    expect(desktopHostIdOf('url:https://elsewhere.example')).toBeNull();
    expect(desktopHostIdOf('relay:srv@wss://relay.example')).toBeNull();
  });
});

describe('persistFocusedDesktopHost', () => {
  test('writes the last focused host once the focus settles', async () => {
    const registry = createRegistry();
    register(registry, 'local');
    register(registry, 'host:pi5');
    register(registry, 'host:msi');
    const timers = manualTimers();
    const written: string[] = [];
    const stop = persistFocusedDesktopHost({ registry, write: async (id) => written.push(id) > 0, delayMs: 400, schedule: timers.schedule });

    registry.focus('host:pi5');
    registry.focus('host:msi');
    expect(written).toEqual([]);
    expect(timers.size()).toBe(1);
    timers.flush();
    expect(written).toEqual(['msi']);

    registry.focus('local');
    timers.flush();
    expect(written).toEqual(['msi', 'local']);
    stop();
  });

  test('ignores registry changes that keep the focus and keys that are not saved hosts', () => {
    const registry = createRegistry();
    register(registry, 'host:pi5');
    const timers = manualTimers();
    const written: string[] = [];
    const stop = persistFocusedDesktopHost({ registry, write: async (id) => written.push(id) > 0, delayMs: 400, schedule: timers.schedule });

    register(registry, 'host:msi');
    register(registry, 'url:https://elsewhere.example');
    registry.focus('url:https://elsewhere.example');
    timers.flush();
    expect(written).toEqual([]);
    stop();
  });

  test('a failed write is swallowed and stopping cancels a pending one', async () => {
    const registry = createRegistry();
    register(registry, 'host:pi5');
    register(registry, 'host:msi');
    const timers = manualTimers();
    let calls = 0;
    const stop = persistFocusedDesktopHost({ registry, write: async () => { calls += 1; throw new Error('shell went away'); }, delayMs: 400, schedule: timers.schedule });

    registry.focus('host:msi');
    timers.flush();
    await Promise.resolve();
    expect(calls).toBe(1);

    registry.focus('host:pi5');
    stop();
    timers.flush();
    expect(calls).toBe(1);
  });
});

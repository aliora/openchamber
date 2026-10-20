import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { SyncEvent } from '@/lib/opencode/events';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { isHostFocusMove, setMultiHostRuntime } from './multi-host-flag';

Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
const { useSmallModelStore } = await import('@/stores/useSmallModelStore');
const { registerBulkArchiveEchoes, shouldConsumeBulkArchiveEcho } = await import('@/sync/bulk-archive-echo');

const archivedEcho = (sessionID: string, archived: number): SyncEvent => ({
  type: 'session.patched',
  properties: { sessionID, patch: { time: { archived } } },
});

describe('runtime-change subscribers on a focus move', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'host:a' });
  });

  beforeEach(() => {
    setMultiHostRuntime(true);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('a focus move is a change of key with several hosts running', () => {
    expect(isHostFocusMove({ runtimeKey: 'host:b', previousRuntimeKey: 'host:a' })).toBe(true);
    expect(isHostFocusMove({ runtimeKey: 'host:a', previousRuntimeKey: 'host:a' })).toBe(false);
    setMultiHostRuntime(false);
    expect(isHostFocusMove({ runtimeKey: 'host:b', previousRuntimeKey: 'host:a' })).toBe(false);
  });

  test('host-keyed answers and archive echoes of the host left behind survive a focus move', () => {
    useSmallModelStore.setState({ byKey: { 'host:a::__global__': { availability: 'available', fetchedAt: Date.now() } } });
    registerBulkArchiveEchoes('host:a', [{ id: 'ses_1', archivedAt: 42 }]);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://b.example', runtimeKey: 'host:b' });

    expect(Object.keys(useSmallModelStore.getState().byKey)).toEqual(['host:a::__global__']);
    expect(shouldConsumeBulkArchiveEcho(archivedEcho('ses_1', 42), 'host:a')).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'host:a' });
  });

  test('a switch of the single window host still forgets them', () => {
    setMultiHostRuntime(false);
    useSmallModelStore.setState({ byKey: { 'host:a::__global__': { availability: 'available', fetchedAt: Date.now() } } });
    registerBulkArchiveEchoes('host:a', [{ id: 'ses_2', archivedAt: 7 }]);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://c.example', runtimeKey: 'host:c' });

    expect(useSmallModelStore.getState().byKey).toEqual({});
    expect(shouldConsumeBulkArchiveEcho(archivedEcho('ses_2', 7), 'host:a')).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import type { HostsAPI } from '@/lib/api/types';
import { opencodeClient } from '@/lib/opencode/client';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import type { HostCredential, HostsListResult, SavedHost } from '../types';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import { createSavedHostRuntimes } from './saved-host-runtimes';
import type { HostRuntimeParts, HostStoreScope } from './types';

const savedHost = (name: string, apiUrl = `https://${name}.example`): SavedHost => ({
  descriptor: { id: name, label: name, kind: 'direct', displayUrl: apiUrl, runtimeKey: `host:${name}`, monitored: true },
  endpoint: { kind: 'direct', apiUrl },
});

const windowHost = savedHost('window');

type Built = { host: SavedHost; credential: HostCredential | null; storeScope: HostStoreScope | undefined };

const createHarness = () => {
  const registry = createHostRegistry(() => { throw new Error('saved hosts bring their parts'); });
  registry.register(windowHost, async () => null, {
    transport: createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient }),
    client: opencodeClient,
  });
  const built: Built[] = [];
  let windowChanged = () => {};
  const runtimes = createSavedHostRuntimes({
    registry,
    isWindowHost: (host) => host.descriptor.runtimeKey === registry.focused().id,
    subscribeWindowChanged: (listener) => {
      windowChanged = listener;
      return () => { windowChanged = () => {}; };
    },
    createParts: (host, credential, _read, storeScope): HostRuntimeParts => {
      built.push({ host, credential, storeScope });
      return {
        transport: createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient }),
        client: opencodeClient,
        storeScope,
      };
    },
  });
  return { registry, runtimes, built, windowChanged: () => windowChanged() };
};

const hostsApi = (lists: Array<HostsListResult | Error>): HostsAPI => ({
  listHosts: async () => {
    const next = lists.length > 1 ? lists.shift() : lists[0];
    if (!next || next instanceof Error) throw next ?? new Error('no list');
    return next;
  },
  getCredential: async (hostId) => ({ token: `token-${hostId}`, requestHeaders: {} }),
});

const ids = (registry: ReturnType<typeof createHarness>['registry']) => registry.list().map((host) => host.id);

describe('saved host runtimes', () => {
  test('every saved host but the window one is registered with its credential, and the focus stays', async () => {
    const { registry, runtimes, built } = createHarness();
    await runtimes.ensure(hostsApi([{ status: 'ok', hosts: [windowHost, savedHost('pi'), savedHost('pc')] }]));

    expect(ids(registry)).toEqual(['host:window', 'host:pi', 'host:pc']);
    expect(registry.focused().id).toBe('host:window');
    expect(built.map((entry) => [entry.host.descriptor.id, entry.credential?.token])).toEqual([['pi', 'token-pi'], ['pc', 'token-pc']]);
    runtimes.stop();
  });

  test('a failed list keeps the hosts, a removed host leaves, and an unsupported list removes them all', async () => {
    const { registry, runtimes } = createHarness();
    const api = hostsApi([
      { status: 'ok', hosts: [savedHost('pi'), savedHost('pc')] },
      new Error('offline'),
      { status: 'ok', hosts: [savedHost('pi')] },
      { status: 'unsupported' },
    ]);
    await runtimes.ensure(api);
    await runtimes.refresh();
    expect(ids(registry)).toEqual(['host:window', 'host:pi', 'host:pc']);
    await runtimes.refresh();
    expect(ids(registry)).toEqual(['host:window', 'host:pi']);
    await runtimes.refresh();
    expect(ids(registry)).toEqual(['host:window']);
    runtimes.stop();
  });

  test('a host whose address changed is registered again on the same store scope', async () => {
    const { registry, runtimes, built } = createHarness();
    await runtimes.ensure(hostsApi([
      { status: 'ok', hosts: [savedHost('pi')] },
      { status: 'ok', hosts: [savedHost('pi')] },
      { status: 'ok', hosts: [savedHost('pi', 'https://pi.lan')] },
    ]));
    const first = registry.get('host:pi');
    await runtimes.refresh();
    expect(registry.get('host:pi')).toBe(first);
    await runtimes.refresh();

    const second = registry.get('host:pi');
    expect(second).not.toBe(first);
    expect(second?.storeScope).toBe(first?.storeScope);
    expect(first?.transport).toBe(second?.transport);
    expect(built.map((entry) => entry.storeScope)).toEqual([undefined, first?.storeScope]);
    runtimes.stop();
  });

  test('a host the window took over is registered again once the window leaves it', async () => {
    const { registry, runtimes, windowChanged } = createHarness();
    await runtimes.ensure(hostsApi([{ status: 'ok', hosts: [savedHost('pi')] }]));
    const saved = registry.get('host:pi');

    registry.register(savedHost('pi'), async () => null, {
      transport: createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient }),
      client: opencodeClient,
    });
    registry.focus('host:pi');
    registry.unregister('host:window');
    windowChanged();
    await runtimes.refresh();
    expect(registry.get('host:pi')).not.toBe(saved);
    expect(saved?.disposed).toBe(true);

    registry.register(windowHost, async () => null, {
      transport: createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient }),
      client: opencodeClient,
    });
    registry.focus('host:window');
    registry.unregister('host:pi');
    windowChanged();
    await runtimes.refresh();
    expect(ids(registry)).toEqual(['host:window', 'host:pi']);
    runtimes.stop();
  });

  test('a saved host connected before the list arrived is kept and leaves with the list', async () => {
    const { registry, runtimes, built } = createHarness();
    const connected = registry.register(savedHost('pi'), async () => null, {
      transport: createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient }),
      client: opencodeClient,
    });

    await runtimes.ensure(hostsApi([{ status: 'ok', hosts: [savedHost('pi')] }, { status: 'ok', hosts: [] }]));
    expect(registry.get('host:pi')).toBe(connected);
    expect(built).toEqual([]);

    await runtimes.refresh();
    expect(registry.get('host:pi')).toBeUndefined();
    expect(connected.disposed).toBe(true);
    runtimes.stop();
  });
});

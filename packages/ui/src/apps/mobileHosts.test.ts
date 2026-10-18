import { beforeEach, describe, expect, test } from 'bun:test';

import type { HostMonitorSink } from '@/lib/hosts/host-monitor';
import { createHostsMonitoring } from '@/lib/hosts/hosts-monitoring';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';

import type { MobileRelayConfig, MobileSavedConnection } from './mobileConnections';
import { createMobileHostsAPI, type MobileHostsDependencies } from './mobileHosts';

const relay: MobileRelayConfig = {
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_studio',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' },
};

const connections: MobileSavedConnection[] = [
  { id: 'mac', label: 'Mac', lastUsedAt: 3, hasToken: true, candidates: [{ kind: 'direct', url: 'http://192.168.1.57:3000' }, { kind: 'relay', relay }] },
  { id: 'pi', label: 'Pi5', lastUsedAt: 2, hasToken: true, candidates: [{ kind: 'direct', url: 'http://192.168.1.56:3000?token=leak' }] },
  { id: 'away', label: 'Away', lastUsedAt: 1, hasToken: false, candidates: [{ kind: 'relay', relay: { ...relay, serverId: 'srv_away' } }] },
  { id: 'web', label: 'Web', lastUsedAt: 0, clientToken: 'oc_client_inline', hasToken: true, candidates: [{ kind: 'direct', url: 'https://web.example' }] },
];

const mobile = (overrides: Partial<MobileHostsDependencies> = {}) => {
  const tokenReads: string[] = [];
  const dependencies: MobileHostsDependencies = {
    readConnections: async () => connections,
    readToken: async (connection) => {
      tokenReads.push(connection.id);
      return connection.hasToken ? { token: `oc_client_${connection.id}` } : {};
    },
    ...overrides,
  };
  return { api: createMobileHostsAPI(dependencies), tokenReads };
};

describe('mobile hosts API', () => {
  test('lists every saved connection with the runtime key its switch uses, without credentials', async () => {
    const { api, tokenReads } = mobile();
    const result = await api.listHosts();
    if (result.status !== 'ok') throw new Error('expected hosts');

    expect(result.hosts.map(({ descriptor }) => [descriptor.id, descriptor.label, descriptor.kind, descriptor.runtimeKey, descriptor.displayUrl])).toEqual([
      ['mac', 'Mac', 'multi', 'relay:srv_studio@wss://relay.example/tunnel', 'http://192.168.1.57:3000/'],
      ['pi', 'Pi5', 'direct', 'http://192.168.1.56:3000', 'http://192.168.1.56:3000/?token=%5BREDACTED%5D'],
      ['away', 'Away', 'relay', 'relay:srv_away@wss://relay.example/tunnel', 'relay://srv_away'],
      ['web', 'Web', 'direct', 'https://web.example', 'https://web.example/'],
    ]);
    expect(result.hosts[0].endpoint).toEqual({ kind: 'multi', apiUrl: 'http://192.168.1.57:3000', relay });
    expect(result.hosts[2].endpoint).toEqual({ kind: 'relay', relay: { ...relay, serverId: 'srv_away' } });
    expect(result.hosts.every(({ descriptor }) => descriptor.monitored)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('oc_client');
    expect(tokenReads).toEqual([]);
  });

  test('reads the credential from the secure store on every call', async () => {
    const { api, tokenReads } = mobile();
    expect(await api.getCredential('mac')).toEqual({ token: 'oc_client_mac', requestHeaders: {} });
    expect(await api.getCredential('mac')).toEqual({ token: 'oc_client_mac', requestHeaders: {} });
    expect(await api.getCredential('away')).toEqual({ token: null, requestHeaders: {} });
    expect(await api.getCredential('missing')).toBeNull();
    expect(tokenReads).toEqual(['mac', 'mac', 'away']);
  });

  test('an expected token the secure store cannot return reads as no token', async () => {
    const { api } = mobile({ readToken: async () => null });
    expect(await api.getCredential('mac')).toEqual({ token: null, requestHeaders: {} });
  });

  test('a failed read of the saved connections is a failure, not an empty list', async () => {
    const { api } = mobile({ readConnections: async () => { throw new Error('storage closed'); } });
    await expect(api.listHosts()).rejects.toThrow('storage closed');
  });
});

describe('monitoring the phone\'s saved connections', () => {
  let started: string[];
  let activeKey: string;

  const monitoring = () => createHostsMonitoring({
    getStore: () => useHostsStore.getState(),
    createTransport: () => ({
      fetch: () => Promise.reject(new Error('unused')),
      releaseTunnel: (): RelayTunnelClient | null => null,
      close: () => undefined,
    }),
    createMonitor: (_transport, sink: HostMonitorSink) => ({
      start: () => { started.push(String(sink.begin())); },
      stop: () => undefined,
      wake: () => undefined,
    }),
    getActiveRuntimeKey: () => activeKey,
    getActiveRelayServerId: () => null,
    adoptTunnel: () => undefined,
    subscribeWake: () => () => undefined,
  });

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    useHostsStore.getState().reset();
    started = [];
  });

  test('the connection the phone is on is the active host and is not monitored', async () => {
    activeKey = 'relay:srv_studio@wss://relay.example/tunnel';
    const { api } = mobile();
    monitoring().ensure(api);
    await settle();

    const state = useHostsStore.getState();
    expect(state.activeHost?.id).toBe('mac');
    expect(state.hosts.map((host) => host.descriptor.id)).toEqual(['pi', 'away', 'web']);
    expect(started).toHaveLength(3);
  });

  test('a direct-only connection is recognized by its address key', async () => {
    activeKey = 'http://192.168.1.56:3000';
    const { api } = mobile();
    monitoring().ensure(api);
    await settle();

    const state = useHostsStore.getState();
    expect(state.activeHost?.id).toBe('pi');
    expect(state.hosts.map((host) => host.descriptor.id)).toEqual(['mac', 'away', 'web']);
  });
});

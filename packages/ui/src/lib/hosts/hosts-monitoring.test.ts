import { beforeEach, describe, expect, test } from 'bun:test';

import type { HostsAPI } from '@/lib/api/types';
import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';
import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import type { HostMonitorSink } from './host-monitor';
import type { HostTransport } from './host-transport';
import { createHostsMonitoring, type HostsMonitoring } from './hosts-monitoring';
import { useHostsStore } from './hosts-store';
import type { HostEndpoint, HostRelayEndpoint, HostsListResult, SavedHost } from './types';

const relay: HostRelayEndpoint = { relayUrl: 'wss://relay.example/ws', serverId: 'srv_studio', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } };

const saved = (id: string, endpoint: HostEndpoint): SavedHost => ({
  descriptor: {
    id,
    label: id,
    kind: endpoint.kind,
    displayUrl: endpoint.kind === 'relay' ? `relay://${endpoint.relay.serverId}` : endpoint.apiUrl,
    runtimeKey: id === 'local' ? 'local' : `host:${id}`,
    monitored: true,
  },
  endpoint,
});

const LOCAL = saved('local', { kind: 'local', apiUrl: 'http://127.0.0.1:4100' });
const STUDIO = saved('studio', { kind: 'relay', relay });
const LAPTOP = saved('laptop', { kind: 'direct', apiUrl: 'https://laptop.example' });

const fakeTunnel = (state: RelayTunnelStatus['state'] = 'connected') => {
  let closed = false;
  const client: RelayTunnelClient = {
    fetch: () => Promise.reject(new Error('unused')),
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => ({ state }),
    subscribeStatus: () => () => undefined,
    retry: () => undefined,
    close: () => { closed = true; },
  };
  return { client, isClosed: () => closed };
};

const detail = (previousRuntimeKey: string, runtimeKey: string): RuntimeEndpointChangedDetail => ({
  apiBaseUrl: 'x', previousApiBaseUrl: 'y', runtimeKey, previousRuntimeKey,
});

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('hosts monitoring', () => {
  let activeKey: string;
  let listResult: () => Promise<HostsListResult>;
  let monitors: Map<string, { started: number; stopped: number; woken: number; sink: HostMonitorSink }>;
  let tunnels: Map<string, ReturnType<typeof fakeTunnel>>;
  let closedTransports: string[];
  let adopted: Array<{ serverId: string; client: RelayTunnelClient }>;
  let activeRelayServerId: string | null;
  let credentialReads: string[];
  let wake: () => void;
  let monitoring: HostsMonitoring;
  let api: HostsAPI;
  let transportIds: WeakMap<HostTransport, string>;

  beforeEach(() => {
    useHostsStore.getState().reset();
    activeKey = 'local';
    listResult = async () => ({ status: 'ok', hosts: [LOCAL, STUDIO, LAPTOP] });
    monitors = new Map();
    tunnels = new Map();
    closedTransports = [];
    adopted = [];
    activeRelayServerId = null;
    credentialReads = [];
    transportIds = new WeakMap();
    wake = () => undefined;
    api = {
      listHosts: () => listResult(),
      getCredential: async (hostId) => {
        credentialReads.push(hostId);
        return { token: `token-${hostId}`, requestHeaders: {} };
      },
    };
    monitoring = createHostsMonitoring({
      getStore: () => useHostsStore.getState(),
      createTransport: (host, getCredential): HostTransport => {
        const id = host.descriptor.id;
        void getCredential();
        const transport: HostTransport = {
          fetch: () => Promise.resolve({ ok: false, reason: 'aborted' }),
          releaseTunnel: () => tunnels.get(id)?.client ?? null,
          close: () => { closedTransports.push(id); },
        };
        transportIds.set(transport, id);
        return transport;
      },
      createMonitor: (transport, sink) => {
        const record = { started: 0, stopped: 0, woken: 0, sink };
        return {
          start() {
            record.started += 1;
            const generation = sink.begin();
            // The test learns which host this monitor serves from the store entry it just reset.
            const entry = useHostsStore.getState().hosts.find((host) => host.snapshot.generation === generation);
            if (entry) monitors.set(entry.descriptor.id, record);
          },
          stop() { record.stopped += 1; },
          wake() { record.woken += 1; },
        };
      },
      getActiveRuntimeKey: () => activeKey,
      getActiveRelayServerId: () => activeRelayServerId,
      adoptTunnel: (endpoint, client) => { adopted.push({ serverId: endpoint.serverId, client }); },
      subscribeWake: (listener) => {
        wake = listener;
        return () => { wake = () => undefined; };
      },
    });
  });

  const ids = () => useHostsStore.getState().hosts.map((host) => host.descriptor.id);

  test('monitors every saved host except the active one, reading credentials per host', async () => {
    monitoring.ensure(api);
    await settle();
    expect(useHostsStore.getState().availability).toBe('ready');
    expect(ids()).toEqual(['studio', 'laptop']);
    // The host the window is on is named, never monitored.
    expect(useHostsStore.getState().activeHost).toBe(LOCAL.descriptor);
    expect([...monitors.keys()].sort()).toEqual(['laptop', 'studio']);
    expect(credentialReads.sort()).toEqual(['laptop', 'studio']);

    monitoring.ensure(api);
    await settle();
    expect(monitors.get('studio')?.started).toBe(1);
  });

  test('hands out the transports of the watched hosts, never the active one', async () => {
    const watchedIds = () => monitoring.watchedTransports().map((transport) => transportIds.get(transport)).sort();
    expect(watchedIds()).toEqual([]);
    monitoring.ensure(api);
    await settle();
    expect(watchedIds()).toEqual(['laptop', 'studio']);

    monitoring.prepareRuntimeSwitch(detail('local', 'host:studio'));
    activeKey = 'host:studio';
    monitoring.completeRuntimeSwitch(detail('local', 'host:studio'));
    await settle();
    expect(watchedIds()).toEqual(['laptop', 'local']);
  });

  test('a window keyed by a host\'s address is on that host, and does not watch it', async () => {
    // A window opened for the laptop, or started on it as the default host,
    // knows it only by its address.
    activeKey = 'url:https://laptop.example';
    monitoring.ensure(api);
    await settle();
    expect(useHostsStore.getState().activeHost).toBe(LAPTOP.descriptor);
    expect(ids()).toEqual(['local', 'studio']);
    expect(monitors.has('laptop')).toBe(false);
  });

  test('an address no saved host has matches nothing', async () => {
    activeKey = 'url:https://elsewhere.example';
    monitoring.ensure(api);
    await settle();
    expect(useHostsStore.getState().activeHost).toBeNull();
    expect(ids()).toEqual(['local', 'studio', 'laptop']);
  });

  test('one host failing leaves the others as they are', async () => {
    monitoring.ensure(api);
    await settle();
    const studio = monitors.get('studio');
    const laptop = monitors.get('laptop');
    if (!studio || !laptop) throw new Error('monitors missing');
    const studioGeneration = useHostsStore.getState().hosts[0].snapshot.generation;
    const laptopGeneration = useHostsStore.getState().hosts[1].snapshot.generation;
    laptop.sink.applySnapshot(laptopGeneration, [{ id: 's1', title: 'Fix', directory: '/w', engine: 'claude', updatedAt: 1, state: 'running' }], 10);
    const laptopBefore = useHostsStore.getState().hosts[1];

    studio.sink.setConnection(studioGeneration, { state: 'backoff', failure: 'unreachable', retryAt: 99 });
    studio.sink.markError(studioGeneration);

    const [studioAfter, laptopAfter] = useHostsStore.getState().hosts;
    expect(studioAfter.snapshot.status).toBe('error');
    expect(laptopAfter).toBe(laptopBefore);
    expect(laptopAfter.snapshot.sessions.get('s1')?.state).toBe('running');
  });

  test('a failed host list keeps the hosts already monitored', async () => {
    monitoring.ensure(api);
    await settle();
    listResult = async () => { throw new Error('ipc down'); };
    wake();
    await settle();
    expect(useHostsStore.getState().availability).toBe('error');
    expect(ids()).toEqual(['studio', 'laptop']);
    expect(monitors.get('studio')?.stopped).toBe(0);
    expect(monitors.get('studio')?.woken).toBe(1);
  });

  test('an unsupported runtime monitors nothing', async () => {
    listResult = async () => ({ status: 'unsupported' });
    monitoring.ensure(api);
    await settle();
    expect(useHostsStore.getState().availability).toBe('unsupported');
    expect(ids()).toEqual([]);
    expect(useHostsStore.getState().activeHost).toBeNull();

    monitoring.ensure(null);
    expect(useHostsStore.getState().availability).toBe('unsupported');
  });

  test('a host whose address changed restarts its monitor; a removed host stops', async () => {
    monitoring.ensure(api);
    await settle();
    const firstLaptop = monitors.get('laptop');
    listResult = async () => ({ status: 'ok', hosts: [LOCAL, saved('laptop', { kind: 'direct', apiUrl: 'https://laptop.example:8443' })] });
    monitoring.refresh();
    await settle();
    expect(ids()).toEqual(['laptop']);
    expect(firstLaptop?.stopped).toBe(1);
    expect(monitors.get('laptop')).not.toBe(firstLaptop);
    expect(monitors.get('studio')?.stopped).toBe(1);
    expect(closedTransports.sort()).toEqual(['laptop', 'studio']);
  });

  test('a runtime switch hands monitors over and the runtime adopts the connected tunnel', async () => {
    monitoring.ensure(api);
    await settle();
    tunnels.set('studio', fakeTunnel());
    const studioMonitor = monitors.get('studio');

    monitoring.prepareRuntimeSwitch(detail('local', 'host:studio'));
    expect(studioMonitor?.stopped).toBe(1);
    expect(adopted).toEqual([{ serverId: 'srv_studio', client: tunnels.get('studio')?.client }]);
    expect(ids()).toEqual(['laptop']);

    activeKey = 'host:studio';
    monitoring.completeRuntimeSwitch(detail('local', 'host:studio'));
    expect(ids()).toEqual(['local', 'laptop']);
    expect(useHostsStore.getState().activeHost).toBe(STUDIO.descriptor);
    expect(monitors.get('local')?.started).toBe(1);
    expect(monitors.get('laptop')?.stopped).toBe(0);
    await settle();

    // Back to Local: the studio is monitored again, on a fresh generation.
    monitoring.prepareRuntimeSwitch(detail('host:studio', 'local'));
    activeKey = 'local';
    monitoring.completeRuntimeSwitch(detail('host:studio', 'local'));
    expect(ids()).toEqual(['studio', 'laptop']);
    expect(monitors.get('studio')).not.toBe(studioMonitor);
    expect(monitors.get('local')?.stopped).toBe(1);
  });

  test('a switch that already holds a tunnel to the server closes the monitor\'s', async () => {
    monitoring.ensure(api);
    await settle();
    const tunnel = fakeTunnel();
    tunnels.set('studio', tunnel);
    activeRelayServerId = 'srv_studio';

    monitoring.prepareRuntimeSwitch(detail('local', 'host:studio'));
    expect(adopted).toEqual([]);
    expect(tunnel.isClosed()).toBe(true);
  });

  test('a credential change on the same runtime hands nothing over', async () => {
    monitoring.ensure(api);
    await settle();
    monitoring.prepareRuntimeSwitch(detail('local', 'local'));
    monitoring.completeRuntimeSwitch(detail('local', 'local'));
    expect(ids()).toEqual(['studio', 'laptop']);
    expect(monitors.get('studio')?.stopped).toBe(0);
  });

  test('stop ends every monitor and clears the store', async () => {
    monitoring.ensure(api);
    await settle();
    monitoring.stop();
    expect(monitors.get('studio')?.stopped).toBe(1);
    expect(monitors.get('laptop')?.stopped).toBe(1);
    expect(useHostsStore.getState()).toMatchObject({ availability: 'unknown', hosts: [] });
  });
});

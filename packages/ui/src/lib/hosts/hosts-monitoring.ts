// Runs one monitor per saved host except the one the window is connected to,
// and hands monitors over when the window switches hosts:
// - before the switch, the monitor of the host becoming active stops. Its relay
//   tunnel, when connected, is adopted as the runtime tunnel, so the switch
//   reuses it instead of dialing the same server a second time;
// - after the switch, the host that stopped being active gets a monitor.
// One host failing to list or answer never touches the others.

import { adoptRelayTunnel, getActiveRelayDescriptor } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeKey, normalizeRuntimeUrlKey, type RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import type { HostsAPI } from '@/lib/api/types';
import { registerProfileFanOutTargets } from '@/lib/settings/profile-fan-out';
import { createHostMonitor, type HostMonitor, type HostMonitorSink, type MonitorEnvironment, type MonitorScheduler } from './host-monitor';
import { createHostTransport, type HostTransport } from './host-transport';
import { useHostsStore, type HostsStore } from './hosts-store';
import type { HostCredential, HostEndpoint, HostRelayEndpoint, HostsListResult, SavedHost } from './types';

type HostsMonitoringDependencies = {
  getStore(): HostsStore;
  createTransport(host: SavedHost, getCredential: () => Promise<HostCredential | null>): HostTransport;
  createMonitor(transport: HostTransport, sink: HostMonitorSink): HostMonitor;
  getActiveRuntimeKey(): string;
  /** The server id of the runtime's relay tunnel, or null when the runtime is not on the relay. */
  getActiveRelayServerId(): string | null;
  adoptTunnel(relay: HostRelayEndpoint, client: RelayTunnelClient): void;
  /** Calls `listener` when the page becomes visible or goes back online. */
  subscribeWake(listener: () => void): () => void;
};

export type HostsMonitoring = {
  /** Starts monitoring with the runtime's hosts API. Idempotent for the same API; null reads as unsupported. */
  ensure(api: HostsAPI | null): void;
  /** Re-reads the saved hosts and makes every monitor try again now. */
  refresh(): void;
  watchedTransports(): readonly HostTransport[];
  /** Runs before the runtime endpoint changes. */
  prepareRuntimeSwitch(detail: RuntimeEndpointChangedDetail): void;
  /** Runs after the runtime endpoint changed. */
  completeRuntimeSwitch(detail: RuntimeEndpointChangedDetail): void;
  stop(): void;
};

type RunningHost = {
  host: SavedHost;
  transport: HostTransport;
  monitor: HostMonitor;
};

const relayOf = (endpoint: HostEndpoint): HostRelayEndpoint | null => (
  endpoint.kind === 'relay' || endpoint.kind === 'multi' ? endpoint.relay : null
);

const sameEndpoint = (left: HostEndpoint, right: HostEndpoint): boolean => {
  const leftRelay = relayOf(left);
  const rightRelay = relayOf(right);
  return left.kind === right.kind
    && (left.kind === 'relay' || right.kind === 'relay' || left.apiUrl === right.apiUrl)
    && leftRelay?.relayUrl === rightRelay?.relayUrl
    && leftRelay?.serverId === rightRelay?.serverId
    && JSON.stringify(leftRelay?.hostEncPubJwk) === JSON.stringify(rightRelay?.hostEncPubJwk);
};

const isSameRuntime = (detail: RuntimeEndpointChangedDetail): boolean => detail.runtimeKey === detail.previousRuntimeKey;

/**
 * Whether the window is on this host. A window that knows the host only by its
 * address is keyed `url:<address>`: one opened for a host (Cmd or Ctrl on its
 * session, Open in new window), or the main window started on a remote default
 * host, which reads its boot outcome only after the runtime key is set. It is
 * on that host all the same, as the footer's `resolveCurrentDesktopHost` says.
 */
const isActiveHost = (host: SavedHost, activeKey: string): boolean => {
  if (host.descriptor.runtimeKey === activeKey) return true;
  if (!activeKey.startsWith('url:') || host.endpoint.kind === 'relay') return false;
  return normalizeRuntimeUrlKey(host.endpoint.apiUrl) === activeKey;
};

export const createHostsMonitoring = (dependencies: HostsMonitoringDependencies): HostsMonitoring => {
  let api: HostsAPI | null = null;
  let started = false;
  let savedHosts: readonly SavedHost[] = [];
  const running = new Map<string, RunningHost>();
  let listRun = 0;
  let unsubscribeWake: (() => void) | null = null;

  const sinkFor = (hostId: string): HostMonitorSink => ({
    begin: () => dependencies.getStore().beginGeneration(hostId),
    setConnection: (generation, connection) => dependencies.getStore().setConnection(hostId, generation, connection),
    applySnapshot: (generation, sessions, at, projects) => dependencies.getStore().applySnapshot(hostId, generation, sessions, at, projects),
    upsertSession: (generation, session) => dependencies.getStore().upsertSession(hostId, generation, session),
    removeSession: (generation, sessionId) => dependencies.getStore().removeSession(hostId, generation, sessionId),
    markError: (generation) => dependencies.getStore().markSnapshotError(hostId, generation),
  });

  const startHost = (host: SavedHost, hostsApi: HostsAPI): void => {
    const hostId = host.descriptor.id;
    const transport = dependencies.createTransport(host, () => hostsApi.getCredential(hostId));
    const monitor = dependencies.createMonitor(transport, sinkFor(hostId));
    running.set(hostId, { host, transport, monitor });
    monitor.start();
  };

  /** Stops a host's monitor. With `handOff`, its connected relay tunnel goes to the runtime. */
  const stopHost = (hostId: string, handOff: boolean): void => {
    const entry = running.get(hostId);
    if (!entry) return;
    running.delete(hostId);
    entry.monitor.stop();
    const relay = relayOf(entry.host.endpoint);
    const tunnel = handOff && relay ? entry.transport.releaseTunnel() : null;
    if (tunnel && relay) {
      // A switch that already holds a live tunnel to this server (the switcher's
      // probe) keeps it: a second leg to the same server would drop one of them.
      if (dependencies.getActiveRelayServerId() === relay.serverId) tunnel.close();
      else dependencies.adoptTunnel(relay, tunnel);
    }
    entry.transport.close();
  };

  const stopAll = (): void => {
    for (const hostId of Array.from(running.keys())) stopHost(hostId, false);
  };

  /** Monitors every saved host except the active one, restarting a host whose address changed. */
  const reconcile = (): void => {
    if (!api) return;
    const activeKey = dependencies.getActiveRuntimeKey();
    const targets = savedHosts.filter((host) => host.descriptor.monitored && !isActiveHost(host, activeKey));
    const byId = new Map(targets.map((host) => [host.descriptor.id, host]));
    for (const [hostId, entry] of running) {
      const target = byId.get(hostId);
      if (!target || !sameEndpoint(entry.host.endpoint, target.endpoint)) stopHost(hostId, false);
    }
    dependencies.getStore().syncHosts(targets.map((host) => host.descriptor));
    dependencies.getStore().setActiveHost(savedHosts.find((host) => isActiveHost(host, activeKey))?.descriptor ?? null);
    for (const host of targets) {
      if (!running.has(host.descriptor.id)) startHost(host, api);
    }
  };

  const refreshHosts = async (): Promise<void> => {
    const hostsApi = api;
    if (!hostsApi) return;
    listRun += 1;
    const run = listRun;
    let result: HostsListResult;
    try {
      result = await hostsApi.listHosts();
    } catch {
      // The previous hosts and their monitors stay: a failed read is not an empty list.
      if (run === listRun && api === hostsApi) dependencies.getStore().setAvailability('error');
      return;
    }
    if (run !== listRun || api !== hostsApi) return;
    if (result.status === 'unsupported') {
      stopAll();
      savedHosts = [];
      dependencies.getStore().syncHosts([]);
      dependencies.getStore().setActiveHost(null);
      dependencies.getStore().setAvailability('unsupported');
      return;
    }
    savedHosts = result.hosts;
    dependencies.getStore().setAvailability('ready');
    reconcile();
  };

  const wakeAll = (): void => {
    for (const entry of running.values()) entry.monitor.wake();
    void refreshHosts();
  };

  const stop = (): void => {
    listRun += 1;
    unsubscribeWake?.();
    unsubscribeWake = null;
    stopAll();
    api = null;
    started = false;
    savedHosts = [];
    dependencies.getStore().reset();
  };

  return {
    ensure(nextApi) {
      if (started && api === nextApi) return;
      if (started) stop();
      started = true;
      if (!nextApi) {
        dependencies.getStore().setAvailability('unsupported');
        return;
      }
      api = nextApi;
      unsubscribeWake = dependencies.subscribeWake(wakeAll);
      void refreshHosts();
    },

    refresh() {
      wakeAll();
    },

    watchedTransports() {
      return Array.from(running.values(), (entry) => entry.transport);
    },

    prepareRuntimeSwitch(detail) {
      if (!api || isSameRuntime(detail)) return;
      const becomingActive = savedHosts.find((host) => isActiveHost(host, detail.runtimeKey));
      if (!becomingActive) return;
      stopHost(becomingActive.descriptor.id, true);
      dependencies.getStore().removeHost(becomingActive.descriptor.id);
    },

    completeRuntimeSwitch(detail) {
      if (!api || isSameRuntime(detail)) return;
      reconcile();
      // The previous host may have been saved or changed while it was active.
      void refreshHosts();
    },

    stop,
  };
};

const browserEnvironment: MonitorEnvironment = {
  isHidden: () => globalThis.document?.visibilityState === 'hidden',
  isOffline: () => globalThis.navigator?.onLine === false,
};

const browserScheduler: MonitorScheduler = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

const subscribeBrowserWake = (listener: () => void): (() => void) => {
  const view = globalThis.window;
  const page = globalThis.document;
  if (!view || !page) return () => {};
  const onVisibility = () => {
    if (page.visibilityState === 'visible') listener();
  };
  view.addEventListener('online', listener);
  page.addEventListener('visibilitychange', onVisibility);
  return () => {
    view.removeEventListener('online', listener);
    page.removeEventListener('visibilitychange', onVisibility);
  };
};

export const hostsMonitoring = createHostsMonitoring({
  getStore: () => useHostsStore.getState(),
  createTransport: (host, getCredential) => createHostTransport(host, getCredential),
  createMonitor: (transport, sink) => createHostMonitor({ transport, sink, environment: browserEnvironment, scheduler: browserScheduler }),
  getActiveRuntimeKey: getRuntimeKey,
  getActiveRelayServerId: () => getActiveRelayDescriptor()?.serverId ?? null,
  adoptTunnel: adoptRelayTunnel,
  subscribeWake: subscribeBrowserWake,
});

registerProfileFanOutTargets(() => hostsMonitoring.watchedTransports());

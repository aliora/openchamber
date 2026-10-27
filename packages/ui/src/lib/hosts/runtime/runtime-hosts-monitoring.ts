import type { StoreApi } from 'zustand/vanilla';
import { z } from 'zod';

import type { HostsAPI } from '@/lib/api/types';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { isActiveHost } from '../active-host';
import { hostTransportOverRuntime, type HostTransport } from '../host-transport';
import { provideRuntimeHostsMonitoring, type HostsMonitoring } from '../hosts-monitoring';
import { useHostsStore, type HostsStore } from '../hosts-store';
import type { HostConnection, HostSnapshot, MonitoredHost, SavedHost } from '../types';
import { parseSettingsDocument } from '@/lib/settings/registry';
import { hostRegistry, hostStoresLive } from './host-bindings';
import { hostRuntimeFetch } from './host-fetch';
import { createHostConnectionSupervisor, type HostConnectionSupervisor, type MonitorEnvironment, type MonitorScheduler } from './host-connection-supervisor';
import { createHostSnapshotProjector, type HostSnapshotInput, type HostSnapshotProjector } from './host-snapshot';
import { savedHostRuntimes, type SavedHostsList } from './saved-host-runtimes';
import type { HostRegistry, HostRuntime } from './types';

type RuntimeHostsDependencies = {
  registry: HostRegistry;
  saved: {
    readonly listed: StoreApi<SavedHostsList>;
    ensure(api: HostsAPI | null): Promise<void>;
    refresh(): Promise<void>;
  };
  getStore(): HostsStore;
  readInput(host: HostRuntime): HostSnapshotInput;
  subscribeInputs(listener: () => void): () => void;
  streamOf(host: HostRuntime): { isLive(): boolean; subscribe(listener: () => void): () => void };
  environment: MonitorEnvironment;
  scheduler: MonitorScheduler;
  subscribeWake(listener: () => void): () => void;
  connect(host: HostRuntime): Promise<void>;
  loadProjects(host: HostRuntime): Promise<boolean>;
  loadServerId(host: HostRuntime): Promise<string | null>;
};

type WatchedRuntime = {
  supervisor: HostConnectionSupervisor;
  transport: HostTransport;
  projector: HostSnapshotProjector;
  unsubscribeStatus: () => void;
};

const CONNECTING: HostConnection = { state: 'connecting' };

const LOADING: HostSnapshot = { status: 'loading', sessions: new Map(), lastCompleteAt: null };

const createRuntimeHostsMonitoring = (dependencies: RuntimeHostsDependencies): HostsMonitoring => {
  const { registry, saved } = dependencies;
  const watched = new Map<HostRuntime, WatchedRuntime>();
  const fetchedServerIds = new Map<string, string>();
  let unsubscribers: Array<() => void> = [];
  let scheduled = false;
  let started = false;

  const focusedKey = (): string | null => (registry.list().length > 0 ? registry.focused().id : null);

  const project = (): void => {
    if (!started) return;
    const { availability, hosts } = saved.listed.getState();
    const activeKey = focusedKey();
    const isFocused = (host: SavedHost) => activeKey !== null && isActiveHost(host, activeKey);
    const rows = hosts
      .filter((host) => host.descriptor.monitored && !isFocused(host))
      .map((host): MonitoredHost => {
        const runtime = registry.get(host.descriptor.runtimeKey);
        const entry = runtime ? watched.get(runtime) : undefined;
        if (!runtime || !entry) return { descriptor: host.descriptor, connection: CONNECTING, snapshot: LOADING };
        return {
          descriptor: host.descriptor,
          connection: runtime.status.getState().connection,
          snapshot: entry.projector(dependencies.readInput(runtime), dependencies.scheduler.now()),
        };
      });
    const store = dependencies.getStore();
    store.setAvailability(availability);
    store.replaceHosts(rows);
    store.setActiveHost(hosts.find(isFocused)?.descriptor ?? null);
    store.setServerIds(new Map(hosts.flatMap((host): [string, string][] => {
      const serverId = 'relay' in host.endpoint ? host.endpoint.relay.serverId : fetchedServerIds.get(host.descriptor.runtimeKey);
      return serverId ? [[host.descriptor.id, serverId]] : [];
    })));
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      project();
    });
  };

  const watch = (runtime: HostRuntime): void => {
    const stream = dependencies.streamOf(runtime);
    const transport = hostTransportOverRuntime(runtime.transport);
    const supervisor = createHostConnectionSupervisor({
      host: { transport, status: runtime.status, isStreamLive: stream.isLive, subscribeStream: stream.subscribe, connect: () => dependencies.connect(runtime) },
      environment: dependencies.environment,
      scheduler: dependencies.scheduler,
    });
    let projectsRequested = false;
    let serverIdRequested = false;
    const onStatus = (): void => {
      schedule();
      if (!serverIdRequested && runtime.status.getState().connection.state === 'live') {
        serverIdRequested = true;
        void dependencies.loadServerId(runtime).then((serverId) => {
          if (!serverId) {
            serverIdRequested = false;
            return;
          }
          fetchedServerIds.set(runtime.id, serverId);
          schedule();
        });
      }
      if (projectsRequested || runtime.status.getState().connection.state !== 'live') return;
      projectsRequested = true;
      if (focusedKey() === runtime.id) return;
      void dependencies.loadProjects(runtime).then((loaded) => {
        if (!loaded) projectsRequested = false;
      });
    };
    watched.set(runtime, { supervisor, transport, projector: createHostSnapshotProjector(), unsubscribeStatus: runtime.status.subscribe(onStatus) });
    supervisor.start();
  };

  const reconcile = (): void => {
    const live = new Set(registry.list());
    for (const [runtime, entry] of watched) {
      if (live.has(runtime)) continue;
      entry.supervisor.stop();
      entry.unsubscribeStatus();
      watched.delete(runtime);
    }
    for (const runtime of live) {
      if (!watched.has(runtime)) watch(runtime);
    }
    schedule();
  };

  const wakeAll = (): void => {
    for (const entry of watched.values()) entry.supervisor.wake();
  };

  const runtimeOfSavedHost = (hostId: string): HostRuntime | undefined => {
    const host = saved.listed.getState().hosts.find((entry) => entry.descriptor.id === hostId);
    return host ? registry.get(host.descriptor.runtimeKey) : undefined;
  };

  const stop = (): void => {
    started = false;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    for (const entry of watched.values()) {
      entry.supervisor.stop();
      entry.unsubscribeStatus();
    }
    watched.clear();
    dependencies.getStore().reset();
  };

  return {
    ensure(api) {
      void saved.ensure(api);
      if (started) return;
      started = true;
      unsubscribers = [
        registry.subscribe(reconcile),
        saved.listed.subscribe(schedule),
        dependencies.subscribeInputs(schedule),
        dependencies.subscribeWake(wakeAll),
      ];
      reconcile();
    },
    refresh() {
      for (const entry of watched.values()) entry.supervisor.reconnect();
      void saved.refresh();
    },
    watchedTransports() {
      const activeKey = focusedKey();
      return [...watched].filter(([runtime]) => runtime.id !== activeKey).map(([, entry]) => entry.transport);
    },
    transportFor(hostId) {
      const runtime = runtimeOfSavedHost(hostId);
      if (!runtime || runtime.id === focusedKey()) return null;
      return watched.get(runtime)?.transport ?? null;
    },
    stop,
  };
};

const readRuntimeInput = (host: HostRuntime): HostSnapshotInput => {
  const sessions = useGlobalSessionsStore.forHost(host.id).getState();
  const projects = useProjectsStore.forHost(host.id).getState();
  return {
    activeSessions: sessions.activeSessions,
    hasLoaded: sessions.hasLoaded,
    listStatus: sessions.status,
    statusById: useGlobalSessionStatusStore.forHost(host.id).getState().statusById,
    pendingBySession: useGlobalBlockingRequestsStore.forHost(host.id).getState().bySession,
    projects: projects.hasServerSnapshot ? projects.projects : null,
    defaultProjectId: projects.defaultProjectId,
  };
};

const loadRuntimeProjects = async (host: HostRuntime): Promise<boolean> => {
  if (useProjectsStore.forHost(host.id).getState().hasServerSnapshot) return true;
  const response = await hostRuntimeFetch(host, '/api/config/settings', { headers: { Accept: 'application/json' } }).catch(() => null);
  if (!response?.ok) return false;
  const settings = parseSettingsDocument(await response.json().catch(() => null));
  if (!settings || !hostStoresLive(host)) return false;
  host.run(() => useProjectsStore.getState().synchronizeFromSettings(settings, { adoptActiveProject: false }));
  return true;
};

const versionSchema = z.object({ serverId: z.string().optional() });

const loadRuntimeServerId = async (host: HostRuntime): Promise<string | null> => {
  const response = await hostRuntimeFetch(host, '/api/version', { headers: { Accept: 'application/json' } }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = versionSchema.safeParse(await response.json().catch(() => null));
  const serverId = parsed.success ? parsed.data.serverId?.trim() : '';
  return serverId || null;
};

const subscribeRuntimeInputs = (listener: () => void): (() => void) => {
  const unsubscribers = [
    useGlobalSessionsStore.subscribeEveryHost(listener),
    useGlobalSessionStatusStore.subscribeEveryHost(listener),
    useGlobalBlockingRequestsStore.subscribeEveryHost(listener),
    useProjectsStore.subscribeEveryHost(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
};

const runtimeStream = (host: HostRuntime) => {
  const config = useConfigStore.forHost(host.id);
  return {
    isLive: () => config.getState().isConnected,
    subscribe: (listener: () => void) => config.subscribe(listener),
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

const subscribeRuntimeWake = (listener: () => void): (() => void) => {
  const unsubscribeBrowser = subscribeBrowserWake(listener);
  const unsubscribeEndpoint = subscribeRuntimeEndpointChanged(listener);
  return () => {
    unsubscribeBrowser();
    unsubscribeEndpoint();
  };
};

type HostConnector = (host: HostRuntime) => Promise<void>;

let hostConnector: HostConnector | null = null;

export const provideHostConnector = (connector: HostConnector | null): void => {
  hostConnector = connector;
};

let installed = false;

export const installRuntimeHostsMonitoring = (): void => {
  if (installed) return;
  installed = true;
  provideRuntimeHostsMonitoring(createRuntimeHostsMonitoring({
    registry: hostRegistry,
    saved: savedHostRuntimes,
    getStore: () => useHostsStore.getState(),
    readInput: readRuntimeInput,
    subscribeInputs: subscribeRuntimeInputs,
    streamOf: runtimeStream,
    environment: browserEnvironment,
    scheduler: browserScheduler,
    subscribeWake: subscribeRuntimeWake,
    connect: (host) => hostConnector?.(host) ?? Promise.resolve(),
    loadProjects: loadRuntimeProjects,
    loadServerId: loadRuntimeServerId,
  }));
};

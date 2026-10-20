import { createStore, type StoreApi } from 'zustand/vanilla';

import type { HostsAPI } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isActiveHost } from '../active-host';
import type { HostCredential, HostEndpoint, HostsAvailability, HostsListResult, SavedHost } from '../types';
import { hostRegistry } from './host-bindings';
import { windowHostKey } from './window-host';
import { createHostParts } from './host-parts';
import type { RuntimeAuthCredentialProvider } from './transport-auth';
import type { HostCredentialReader, HostRegistry, HostRuntime, HostRuntimeParts, HostStoreScope, RuntimeTransportEndpoint } from './types';

type SavedHostRuntimesDependencies = {
  registry: HostRegistry;
  createParts(host: SavedHost, credential: HostCredential | null, read: HostCredentialReader, storeScope: HostStoreScope | undefined): HostRuntimeParts;
  isWindowHost(host: SavedHost): boolean;
  subscribeWindowChanged(listener: () => void): () => void;
};

export type SavedHostsList = {
  availability: HostsAvailability;
  hosts: readonly SavedHost[];
};

type SavedHostRuntimes = {
  readonly listed: StoreApi<SavedHostsList>;
  ensure(api: HostsAPI | null): Promise<void>;
  refresh(): Promise<void>;
  stop(): void;
};

type OwnedHost = {
  host: SavedHost;
  runtime: HostRuntime;
};

const sameEndpoint = (left: HostEndpoint, right: HostEndpoint): boolean => JSON.stringify(left) === JSON.stringify(right);

export const createSavedHostRuntimes = (dependencies: SavedHostRuntimesDependencies): SavedHostRuntimes => {
  const { registry } = dependencies;
  const owned = new Map<string, OwnedHost>();
  const listed = createStore<SavedHostsList>()(() => ({ availability: 'unknown', hosts: [] }));
  let api: HostsAPI | null = null;
  let listRun = 0;
  let unsubscribeWindow: (() => void) | null = null;

  const forgetReplaced = (): void => {
    for (const [id, entry] of owned) {
      if (registry.get(id) !== entry.runtime) owned.delete(id);
    }
  };

  const unregisterOwned = (keep: ReadonlySet<string>): void => {
    for (const id of [...owned.keys()]) {
      if (keep.has(id)) continue;
      owned.delete(id);
      registry.unregister(id);
    }
  };

  const register = async (host: SavedHost, hostsApi: HostsAPI, run: number): Promise<void> => {
    const read: HostCredentialReader = () => hostsApi.getCredential(host.descriptor.id);
    const credential = await read().catch(() => null);
    if (run !== listRun) return;
    const id = host.descriptor.runtimeKey;
    const previous = owned.get(id);
    if (previous && sameEndpoint(previous.host.endpoint, host.endpoint)) return;
    const existing = registry.get(id);
    if (!previous && existing) {
      owned.set(id, { host, runtime: existing });
      return;
    }
    const runtime = registry.register(host, read, dependencies.createParts(host, credential, read, previous?.runtime.storeScope));
    owned.set(id, { host, runtime });
  };

  const apply = async (hosts: readonly SavedHost[], hostsApi: HostsAPI, run: number): Promise<void> => {
    forgetReplaced();
    const targets = hosts.filter((host) => !dependencies.isWindowHost(host));
    unregisterOwned(new Set(targets.map((host) => host.descriptor.runtimeKey)));
    await Promise.all(targets.map((host) => register(host, hostsApi, run)));
  };

  const refresh = async (): Promise<void> => {
    const hostsApi = api;
    if (!hostsApi) return;
    listRun += 1;
    const run = listRun;
    let result: HostsListResult;
    try {
      result = await hostsApi.listHosts();
    } catch {
      if (run === listRun && api === hostsApi) listed.setState({ availability: 'error' });
      return;
    }
    if (run !== listRun || api !== hostsApi) return;
    if (result.status === 'unsupported') {
      listed.setState({ availability: 'unsupported', hosts: [] });
      forgetReplaced();
      unregisterOwned(new Set());
      return;
    }
    listed.setState({ availability: 'ready', hosts: result.hosts });
    await apply(result.hosts, hostsApi, run);
  };

  const stop = (): void => {
    listRun += 1;
    unsubscribeWindow?.();
    unsubscribeWindow = null;
    api = null;
    listed.setState({ availability: 'unknown', hosts: [] });
    forgetReplaced();
    unregisterOwned(new Set());
  };

  return {
    listed,
    ensure: async (nextApi) => {
      if (api === nextApi) return;
      stop();
      if (!nextApi) return;
      api = nextApi;
      unsubscribeWindow = dependencies.subscribeWindowChanged(() => {
        void refresh();
      });
      await refresh();
    },
    refresh,
    stop,
  };
};

const endpointOf = (endpoint: HostEndpoint): RuntimeTransportEndpoint => {
  if (endpoint.kind !== 'relay') return { apiBaseUrl: endpoint.apiUrl };
  return { apiBaseUrl: globalThis.location?.origin ?? '', relay: endpoint.relay };
};

const createSavedHostParts: SavedHostRuntimesDependencies['createParts'] = (host, credential, read, storeScope) => {
  const readToken: RuntimeAuthCredentialProvider = async () => {
    const latest = await read().catch(() => null);
    return latest?.token ? { type: 'bearer', token: latest.token } : null;
  };
  const endpoint = { ...endpointOf(host.endpoint), clientToken: credential?.token ?? null, requestHeaders: { ...credential?.requestHeaders } };
  return createHostParts(host.descriptor.runtimeKey, endpoint, readToken, storeScope);
};

export const savedHostRuntimes = createSavedHostRuntimes({
  registry: hostRegistry,
  createParts: createSavedHostParts,
  isWindowHost: (host) => isActiveHost(host, windowHostKey() ?? getRuntimeKey()),
  subscribeWindowChanged: (listener) => subscribeRuntimeEndpointChanged(listener),
});

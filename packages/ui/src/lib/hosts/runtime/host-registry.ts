import { createStore } from 'zustand/vanilla';

import type { SavedHost } from '../types';
import { runWithHost } from './ambient-host';
import type { CreateHostRuntimeParts, HostId, HostRegistry, HostRuntime, HostRuntimeParts, HostStatus } from './types';

type RegisteredHost = {
  readonly runtime: HostRuntime;
  readonly forwardTo: (successor: HostRuntime) => void;
};

const createHostRuntime = (host: SavedHost, parts: HostRuntimeParts): RegisteredHost => {
  let disposed = false;
  let successor: HostRuntime | null = null;
  const runtime: HostRuntime = {
    id: host.descriptor.runtimeKey,
    get descriptor() {
      return successor?.descriptor ?? host.descriptor;
    },
    get transport() {
      return successor?.transport ?? parts.transport;
    },
    get client() {
      return successor?.client ?? parts.client;
    },
    status: createStore<HostStatus>()(() => ({ connection: { state: 'connecting' } })),
    storeScope: parts.storeScope ?? { hostId: host.descriptor.runtimeKey },
    instance: (key) => key.resolve(runtime),
    run: (fn) => (successor ? successor.run(fn) : runWithHost(runtime, fn)),
    get disposed() {
      return disposed;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      parts.transport.close();
    },
  };
  return {
    runtime,
    forwardTo: (next) => {
      successor = next;
    },
  };
};

export const createHostRegistry = (createParts: CreateHostRuntimeParts): HostRegistry => {
  const hosts = new Map<HostId, HostRuntime>();
  const forwarders = new WeakMap<HostRuntime, (successor: HostRuntime) => void>();
  const listeners = new Set<() => void>();
  let listed: readonly HostRuntime[] = [];
  let focusedId: HostId | null = null;

  const changed = (): void => {
    listed = [...hosts.values()];
    for (const listener of [...listeners]) listener();
  };

  return {
    get: (id) => hosts.get(id),
    list: () => listed,
    focused: () => {
      const host = focusedId === null ? undefined : hosts.get(focusedId);
      if (!host) throw new Error('No host is focused');
      return host;
    },
    focus: (id) => {
      if (!hosts.has(id)) throw new Error(`Unknown host: ${id}`);
      if (focusedId === id) return;
      focusedId = id;
      changed();
    },
    register: (host, credential, parts) => {
      const { runtime, forwardTo } = createHostRuntime(host, parts ?? createParts(host, credential));
      forwarders.set(runtime, forwardTo);
      const replaced = hosts.get(runtime.id);
      hosts.set(runtime.id, runtime);
      focusedId ??= runtime.id;
      if (replaced?.storeScope === runtime.storeScope) forwarders.get(replaced)?.(runtime);
      replaced?.dispose();
      changed();
      return runtime;
    },
    unregister: (id) => {
      const runtime = hosts.get(id);
      if (!runtime) return;
      hosts.delete(id);
      if (focusedId === id) focusedId = hosts.keys().next().value ?? null;
      runtime.dispose();
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

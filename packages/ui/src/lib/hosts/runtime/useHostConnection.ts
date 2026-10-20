import React from 'react';

import type { HostConnection } from '../types';
import { hostRegistry } from './host-bindings';
import type { HostRegistry } from './types';

const subscribeHostConnections = (registry: HostRegistry, listener: () => void): (() => void) => {
  let statusSubscriptions: Array<() => void> = [];
  const watchStatuses = (): void => {
    for (const unsubscribe of statusSubscriptions) unsubscribe();
    statusSubscriptions = registry.list().map((host) => host.status.subscribe(listener));
  };
  watchStatuses();
  const unsubscribeRegistry = registry.subscribe(() => {
    watchStatuses();
    listener();
  });
  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of statusSubscriptions) unsubscribe();
  };
};

const readHostConnection = (registry: HostRegistry, hostId: string | null): HostConnection | null => (
  hostId === null ? null : registry.get(hostId)?.status.getState().connection ?? null
);

const subscribe = (listener: () => void): (() => void) => subscribeHostConnections(hostRegistry, listener);

export const useHostConnection = (hostId: string | null): HostConnection | null => {
  const read = React.useCallback(() => readHostConnection(hostRegistry, hostId), [hostId]);
  return React.useSyncExternalStore(subscribe, read, read);
};

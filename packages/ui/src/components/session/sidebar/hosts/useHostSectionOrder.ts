import React from 'react';

import { moveHostInOrder, primaryHostOrderKey, sortByHostOrder, type HostIdentity } from '@/lib/hosts/host-order';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

export type HostSectionOrder = {
  runtimeKeys: readonly string[];
  moveHost: (fromRuntimeKey: string, toRuntimeKey: string) => void;
};

export const saveHostOrder = (order: string[]): void => {
  useSessionDisplayStore.getState().setHostOrder(order);
  void import('@/lib/persistence').then(({ updateDesktopSettings }) => updateDesktopSettings({ sidebarHostOrder: order }));
};

export const orderHostIdentities = (
  descriptors: readonly HostDescriptor[],
  serverIdByHostId: ReadonlyMap<string, string>,
  order: readonly string[],
): HostIdentity[] => sortByHostOrder(
  descriptors.map((descriptor): HostIdentity => ({ descriptor, serverId: serverIdByHostId.get(descriptor.id) ?? null })),
  (identity) => identity,
  order,
);

export const useHostSectionOrder = (
  activeHost: HostDescriptor | null,
  activeRuntimeKey: string,
  monitored: readonly HostDescriptor[],
): HostSectionOrder => {
  const order = useSessionDisplayStore((state) => state.hostOrder);
  const serverIdByHostId = useHostsStore((state) => state.serverIdByHostId);
  const identities = React.useMemo(
    () => orderHostIdentities(activeHost ? [activeHost, ...monitored] : monitored, serverIdByHostId, order),
    [activeHost, monitored, order, serverIdByHostId],
  );
  const runtimeKeys = React.useMemo(
    () => (activeHost ? identities.map((identity) => identity.descriptor.runtimeKey) : [activeRuntimeKey, ...identities.map((identity) => identity.descriptor.runtimeKey)]),
    [activeHost, activeRuntimeKey, identities],
  );
  const moveHost = React.useCallback((fromRuntimeKey: string, toRuntimeKey: string) => {
    const keyOf = (runtimeKey: string) => {
      const identity = identities.find((entry) => entry.descriptor.runtimeKey === runtimeKey);
      return identity ? primaryHostOrderKey(identity) : null;
    };
    const fromKey = keyOf(fromRuntimeKey);
    const toKey = keyOf(toRuntimeKey);
    if (!fromKey || !toKey || fromKey === toKey) return;
    saveHostOrder(moveHostInOrder(useSessionDisplayStore.getState().hostOrder, identities, fromKey, toKey));
  }, [identities]);
  return React.useMemo(() => ({ runtimeKeys, moveHost }), [moveHost, runtimeKeys]);
};

import React from 'react';

import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { SessionSidebarActivityItem, SidebarPinnedEntry } from '../sessionSidebarRowModel';
import type { HostSessionEntry } from './hostSessionList';
import { movePinnedInOrder, pinnedOrderKeys, sortByPinnedOrder } from './pinnedOrder';
import type { SidebarRemoteHost } from './remoteHostProjection';

type KeyedEntry = { entry: SidebarPinnedEntry; keys: readonly string[]; updatedAt: number };

const savePinnedOrder = (order: string[]): void => {
  useSessionDisplayStore.getState().setPinnedOrder(order);
  void import('@/lib/persistence').then(({ updateDesktopSettings }) => updateDesktopSettings({ sidebarPinnedOrder: order }));
};

/**
 * Every host's pinned sessions in one list, in the order the user dragged
 * them into (`sidebarPinnedOrder`, shared by every client); sessions the
 * order does not name follow, newest first. Null while the zone is hidden.
 */
export const usePinnedZone = (args: {
  enabled: boolean;
  activeHost: HostDescriptor | null;
  activeRuntimeKey: string;
  activeSessions: readonly HostSessionEntry<SessionSidebarActivityItem>[];
  monitored: readonly SidebarRemoteHost[];
}) => {
  const { enabled, activeHost, activeRuntimeKey, activeSessions, monitored } = args;
  const order = useSessionDisplayStore((state) => state.pinnedOrder);
  const serverIdByHostId = useHostsStore((state) => state.serverIdByHostId);

  const keyed = React.useMemo((): KeyedEntry[] => {
    if (!enabled) return [];
    const activeIdentity = {
      descriptor: { label: activeHost?.label ?? activeRuntimeKey },
      serverId: activeHost ? serverIdByHostId.get(activeHost.id) ?? null : null,
    };
    const local = activeSessions.filter((entry) => entry.pinned).map((entry): KeyedEntry => {
      const keys = pinnedOrderKeys(activeIdentity, entry.id);
      return { entry: { kind: 'local', sortKey: keys[0], item: entry.value }, keys, updatedAt: entry.updatedAt };
    });
    const remote = monitored.flatMap((host) => {
      const identity = { descriptor: host.descriptor, serverId: serverIdByHostId.get(host.descriptor.id) ?? null };
      return host.sessions.filter((item) => item.session.pinned === true).map((item): KeyedEntry => {
        const keys = pinnedOrderKeys(identity, item.session.id);
        return { entry: { kind: 'remote', sortKey: keys[0], item }, keys, updatedAt: item.session.updatedAt };
      });
    });
    const newestFirst = [...local, ...remote].sort((left, right) => right.updatedAt - left.updatedAt);
    return sortByPinnedOrder(newestFirst, (entry) => entry.keys, order);
  }, [activeHost, activeRuntimeKey, activeSessions, enabled, monitored, order, serverIdByHostId]);

  const pinned = React.useMemo(() => (enabled ? keyed.map((entry) => entry.entry) : null), [enabled, keyed]);

  const movePinned = React.useCallback((fromKey: string, toKey: string) => {
    savePinnedOrder(movePinnedInOrder(useSessionDisplayStore.getState().pinnedOrder, keyed.map((entry) => entry.keys), fromKey, toKey));
  }, [keyed]);

  return { pinned, movePinned };
};

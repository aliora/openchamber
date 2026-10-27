import type { HostConnection, HostDescriptor } from '@/lib/hosts/types';

import type { SessionSortOrder } from '@/stores/useSessionDisplayStore';
import { DEFAULT_SESSION_SORT_ORDER, sessionStatusRank, sortSessionsBy } from '../sessionSort';

export const HOST_SESSION_INITIAL_COUNT = 3;

type HostSessionState = {
  waiting: boolean;
  running: boolean;
  pinned: boolean;
  current: boolean;
};

export type HostSessionEntry<T> = HostSessionState & {
  id: string;
  value: T;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const isAlwaysShown = (entry: HostSessionState): boolean => entry.waiting || entry.pinned || entry.current;

export const sortHostSessionEntries = <T>(
  entries: readonly HostSessionEntry<T>[],
  order: SessionSortOrder = DEFAULT_SESSION_SORT_ORDER,
): HostSessionEntry<T>[] => sortSessionsBy(entries, order, (entry) => ({
  id: entry.id,
  title: entry.title,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  hostRank: 0,
  statusRank: sessionStatusRank(entry),
  pinned: entry.pinned,
}));

type HostSessionPage<T> = { visible: T[]; hiddenCount: number; canShowFewer: boolean };

export const selectHostSessionPage = <T>(
  sorted: readonly HostSessionEntry<T>[],
  shownCount: number = HOST_SESSION_INITIAL_COUNT,
): HostSessionPage<T> => {
  const alwaysShownCount = sorted.filter(isAlwaysShown).length;
  const pagedCount = sorted.length - alwaysShownCount;
  let freeSlots = Math.max(0, shownCount - alwaysShownCount);
  const visible = sorted.filter((entry) => {
    if (isAlwaysShown(entry)) return true;
    if (freeSlots === 0) return false;
    freeSlots -= 1;
    return true;
  });
  const hiddenCount = sorted.length - visible.length;
  const initialHidden = Math.max(0, pagedCount - Math.max(0, HOST_SESSION_INITIAL_COUNT - alwaysShownCount));
  return {
    visible: visible.map((entry) => entry.value),
    hiddenCount,
    canShowFewer: hiddenCount === 0 && initialHidden > 0 && shownCount > HOST_SESSION_INITIAL_COUNT,
  };
};

export const isHiddenLocalHost = (host: { descriptor: HostDescriptor; connection: HostConnection }): boolean => (
  host.descriptor.kind === 'local' && host.connection.state !== 'live'
);

export const hostSessionListKey = (runtimeKey: string): string => `host-list:${runtimeKey}`;

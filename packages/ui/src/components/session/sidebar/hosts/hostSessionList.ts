import type { HostConnection, HostDescriptor } from '@/lib/hosts/types';

export const HOST_SESSION_LIMIT = 3;

type HostSessionState = {
  waiting: boolean;
  running: boolean;
  pinned: boolean;
};

export type HostSessionEntry<T> = HostSessionState & {
  id: string;
  value: T;
  updatedAt: number;
};

const rankOf = (entry: HostSessionState): number => {
  if (entry.waiting) return 0;
  if (entry.running) return 1;
  return entry.pinned ? 2 : 3;
};

const isAlwaysShown = (entry: HostSessionState): boolean => entry.waiting || entry.pinned;

export const sortHostSessionEntries = <T>(entries: readonly HostSessionEntry<T>[]): HostSessionEntry<T>[] => (
  [...entries].sort((left, right) => (
    rankOf(left) - rankOf(right) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  ))
);

export type HostSessionPage<T> = { visible: T[]; hiddenCount: number };

export const selectHostSessionPage = <T>(
  sorted: readonly HostSessionEntry<T>[],
  revealAll: boolean,
  limit = HOST_SESSION_LIMIT,
): HostSessionPage<T> => {
  if (revealAll) return { visible: sorted.map((entry) => entry.value), hiddenCount: 0 };
  let freeSlots = Math.max(0, limit - sorted.filter(isAlwaysShown).length);
  const visible = sorted.filter((entry) => {
    if (isAlwaysShown(entry)) return true;
    if (freeSlots === 0) return false;
    freeSlots -= 1;
    return true;
  });
  return { visible: visible.map((entry) => entry.value), hiddenCount: sorted.length - visible.length };
};

export const isHiddenLocalHost = (host: { descriptor: HostDescriptor; connection: HostConnection }): boolean => (
  host.descriptor.kind === 'local' && host.connection.state !== 'live'
);

export const hostSessionListKey = (runtimeKey: string): string => `host-list:${runtimeKey}`;

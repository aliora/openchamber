import type { I18nKey } from '@/lib/i18n';
import type { SessionSortOrder } from '@/stores/useSessionDisplayStore';

export const SESSION_SORT_OPTIONS = [
  ['activity', 'sessions.sidebar.header.sessionSort.activity'],
  ['created', 'sessions.sidebar.header.sessionSort.created'],
  ['name', 'sessions.sidebar.header.sessionSort.name'],
  ['host', 'sessions.sidebar.header.sessionSort.host'],
  ['status', 'sessions.sidebar.header.sessionSort.status'],
] as const satisfies readonly (readonly [SessionSortOrder, I18nKey])[];

export const DEFAULT_SESSION_SORT_ORDER: SessionSortOrder = 'activity';

export type SessionStatusRank = 0 | 1 | 2;

export const sessionStatusRank = (state: { waiting: boolean; running: boolean }): SessionStatusRank => {
  if (state.waiting) return 0;
  return state.running ? 1 : 2;
};

export type SortableSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  hostRank: number;
  statusRank: SessionStatusRank;
  pinned: boolean;
};

const byActivity = (left: SortableSession, right: SortableSession): number => right.updatedAt - left.updatedAt;

const byIdentity = (left: SortableSession, right: SortableSession): number => (
  left.hostRank - right.hostRank || left.id.localeCompare(right.id)
);

const byMissingTitle = (left: SortableSession, right: SortableSession): number => Number(!left.title.trim()) - Number(!right.title.trim());

const PRIMARY: Record<SessionSortOrder, (left: SortableSession, right: SortableSession) => number> = {
  activity: byActivity,
  created: (left, right) => right.createdAt - left.createdAt || byActivity(left, right),
  name: (left, right) => byMissingTitle(left, right) || left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true }) || byActivity(left, right),
  host: (left, right) => left.hostRank - right.hostRank || byActivity(left, right),
  status: (left, right) => left.statusRank - right.statusRank || byActivity(left, right),
};

const byPinned = (left: SortableSession, right: SortableSession): number => Number(right.pinned) - Number(left.pinned);

export const compareSortableSessions = (order: SessionSortOrder) => (left: SortableSession, right: SortableSession): number => (
  byPinned(left, right) || PRIMARY[order](left, right) || byIdentity(left, right)
);

export const sortSessionsBy = <T>(items: readonly T[], order: SessionSortOrder, keyOf: (item: T) => SortableSession): T[] => {
  const compare = compareSortableSessions(order);
  return items
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((left, right) => compare(left.key, right.key))
    .map((entry) => entry.item);
};

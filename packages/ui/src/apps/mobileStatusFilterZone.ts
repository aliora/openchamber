import type { SessionStatusFilter } from '@/stores/useSessionDisplayStore';

export const isStatusFilterListActive = (filter: SessionStatusFilter, normalizedQuery: string, editingOrder: boolean): boolean => (
  filter !== 'all' && !normalizedQuery && !editingOrder
);

export const pickStatusFilterZone = <Zone>(
  filter: SessionStatusFilter,
  zones: { attention: Zone; running: Zone },
): Zone | null => {
  if (filter === 'all') return null;
  return filter === 'attention' ? zones.attention : zones.running;
};

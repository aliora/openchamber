import { describe, expect, test } from 'bun:test';

import { sessionStatusRank, sortSessionsBy, type SortableSession } from './sessionSort';

const row = (id: string, extra: Partial<SortableSession> = {}): SortableSession => ({
  id, title: id, createdAt: 0, updatedAt: 0, hostRank: 0, statusRank: 2, pinned: false, ...extra,
});

const rows = [
  row('b', { title: 'beta 10', createdAt: 5, updatedAt: 1, hostRank: 1, statusRank: 1 }),
  row('a', { title: 'Beta 2', createdAt: 1, updatedAt: 7, hostRank: 2 }),
  row('c', { title: 'alpha', createdAt: 9, updatedAt: 3, hostRank: 0, statusRank: 0 }),
];
const ids = (order: Parameters<typeof sortSessionsBy>[1]) => sortSessionsBy(rows, order, (item) => item).map((item) => item.id);

describe('sortSessionsBy', () => {
  test('orders by last interaction, creation, name, host and status', () => {
    expect(ids('activity')).toEqual(['a', 'c', 'b']);
    expect(ids('created')).toEqual(['c', 'b', 'a']);
    expect(ids('name')).toEqual(['c', 'a', 'b']);
    expect(ids('host')).toEqual(['c', 'b', 'a']);
    expect(ids('status')).toEqual(['c', 'b', 'a']);
  });

  test('lists untitled sessions after the named ones by name', () => {
    const untitled = [row('blank', { title: '', updatedAt: 9 }), row('space', { title: ' ' }), row('named', { title: 'zeta' })];
    expect(sortSessionsBy(untitled, 'name', (item) => item).map((item) => item.id)).toEqual(['named', 'blank', 'space']);
  });

  test('breaks ties by host and id so every client lists the same order', () => {
    const tied = [row('z', { hostRank: 1 }), row('y', { hostRank: 0 }), row('x', { hostRank: 1 })];
    expect(sortSessionsBy(tied, 'activity', (item) => item).map((item) => item.id)).toEqual(['y', 'x', 'z']);
  });

  test('lists pinned sessions first whatever the order', () => {
    const pinnedRows = [row('old', { updatedAt: 1, createdAt: 1, title: 'zeta', pinned: true }), ...rows];
    for (const order of ['activity', 'created', 'name', 'host', 'status'] as const) {
      expect(sortSessionsBy(pinnedRows, order, (item) => item)[0]?.id).toBe('old');
    }
  });

  test('orders pinned sessions among themselves by the chosen order', () => {
    const pinnedRows = [row('p1', { updatedAt: 2, pinned: true }), row('p2', { updatedAt: 9, pinned: true }), row('free', { updatedAt: 99 })];
    expect(sortSessionsBy(pinnedRows, 'activity', (item) => item).map((item) => item.id)).toEqual(['p2', 'p1', 'free']);
  });

  test('ranks waiting before running before the rest', () => {
    expect([sessionStatusRank({ waiting: true, running: true }), sessionStatusRank({ waiting: false, running: true }), sessionStatusRank({ waiting: false, running: false })]).toEqual([0, 1, 2]);
  });
});

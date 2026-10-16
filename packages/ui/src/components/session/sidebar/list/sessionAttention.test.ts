import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { selectListedRootSessions } from './sessionAttention';

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: id,
  directory: '/repo',
  projectID: 'project',
  agent: 'build',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...extra,
});

const ordered = [
  session('root-b'),
  session('root-a'),
  session('child', { parentID: 'root-a' }),
  session('grandchild', { parentID: 'child' }),
  session('archived', { time: { created: 1, updated: 1, archived: 2 } }),
];
const sessionById = new Map(ordered.map((entry) => [entry.id, entry]));
const ids = (sessions: readonly Session[]) => sessions.map((entry) => entry.id);

describe('selectListedRootSessions', () => {
  test('lists the top-level session of a subagent that waits on the user, in list order', () => {
    expect(ids(selectListedRootSessions({
      orderedSessions: ordered,
      sessionById,
      treeIds: new Set(['grandchild', 'root-b']),
    }))).toEqual(['root-b', 'root-a']);
  });

  test('counts a failure only for the session the user started', () => {
    expect(ids(selectListedRootSessions({
      orderedSessions: ordered,
      sessionById,
      treeIds: new Set(),
      rootIds: new Set(['child', 'root-b']),
    }))).toEqual(['root-b']);
  });

  test('leaves out archived sessions and sessions the list does not hold', () => {
    expect(ids(selectListedRootSessions({
      orderedSessions: ordered,
      sessionById,
      treeIds: new Set(['archived', 'unknown']),
    }))).toEqual([]);
  });

  test('lists nothing while nothing waits', () => {
    expect(selectListedRootSessions({ orderedSessions: ordered, sessionById, treeIds: new Set() })).toEqual([]);
  });
});

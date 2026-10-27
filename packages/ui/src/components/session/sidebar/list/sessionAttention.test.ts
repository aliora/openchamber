import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { selectListedRootSessions, selectScheduledSessions, selectZoneSessions } from './sessionAttention';

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

describe('selectZoneSessions', () => {
  const inWork = { openchamber: { work: { state: 'open' } } };
  const pinnedKey = (id: string) => getPinnedSessionKey(getRuntimeKey(), '/repo', id) ?? '';
  const zoneSessions = [
    session('waiting-in-work', { metadata: inWork }),
    session('working', { metadata: inWork }),
    session('waiting-pinned'),
    session('pinned-in-work', { metadata: inWork }),
    session('subagent', { parentID: 'working', metadata: inWork }),
  ];
  const select = (search: boolean) => selectZoneSessions({
    orderedSessions: zoneSessions,
    pinnedSessionIds: new Set([pinnedKey('waiting-pinned'), pinnedKey('pinned-in-work')]),
    attentionIds: new Set(['waiting-in-work', 'waiting-pinned']),
    showPinned: true,
    showWork: true,
    search,
  });

  test('a session Needs you lists is not repeated in In work; Pinned keeps its own', () => {
    const zones = select(false);
    expect(ids(zones.work)).toEqual(['working']);
    expect(ids(zones.pinned)).toEqual(['waiting-pinned', 'pinned-in-work']);
  });

  test('a search lists each match once, so Pinned leaves out what Needs you lists too', () => {
    const zones = select(true);
    expect(ids(zones.work)).toEqual(['working']);
    expect(ids(zones.pinned)).toEqual(['pinned-in-work']);
  });

  test('hidden zones list nothing', () => {
    expect(selectZoneSessions({
      orderedSessions: zoneSessions,
      pinnedSessionIds: new Set(),
      attentionIds: new Set(),
      showPinned: false,
      showWork: false,
      search: false,
    })).toEqual({ pinned: [], work: [] });
  });
});

describe('scheduled runs', () => {
  const scheduled = { openchamber: { kind: 'scheduled' } };
  const inWork = { openchamber: { kind: 'scheduled', work: { state: 'open' } } };
  const pinnedKey = (id: string) => getPinnedSessionKey(getRuntimeKey(), '/repo', id) ?? '';
  const runs = [
    session('nightly', { metadata: scheduled }),
    session('nightly-in-work', { metadata: inWork }),
    session('pinned-run', { metadata: scheduled }),
    session('asks-run', { metadata: scheduled }),
    session('run-child', { parentID: 'nightly', metadata: scheduled }),
    session('old-run', { metadata: scheduled, time: { created: 1, updated: 1, archived: 2 } }),
    session('manual'),
  ];
  const pinnedSessionIds = new Set([pinnedKey('pinned-run')]);
  const attentionIds = new Set(['asks-run']);
  const select = (search: boolean) => selectScheduledSessions({ orderedSessions: runs, pinnedSessionIds, attentionIds, search });

  test('lists unpinned top-level scheduled runs, leaving out pinned, sub-, archived and manual sessions', () => {
    expect(ids(select(false))).toEqual(['nightly', 'nightly-in-work', 'asks-run']);
  });

  test('a search leaves out what Needs you lists too', () => {
    expect(ids(select(true))).toEqual(['nightly', 'nightly-in-work']);
  });

  test('a scheduled run in work stays out of In work, a pinned one stays in Pinned', () => {
    const zones = selectZoneSessions({
      orderedSessions: [...runs, session('tracked', { metadata: { openchamber: { work: { state: 'open' } } } })],
      pinnedSessionIds,
      attentionIds,
      showPinned: true,
      showWork: true,
      search: false,
    });
    expect(ids(zones.work)).toEqual(['tracked']);
    expect(ids(zones.pinned)).toEqual(['pinned-run']);
  });

  test('with grouping off a scheduled run in work is listed in In work like any other session', () => {
    const zones = selectZoneSessions({
      orderedSessions: runs,
      pinnedSessionIds,
      attentionIds,
      showPinned: true,
      showWork: true,
      groupScheduled: false,
      search: false,
    });
    expect(ids(zones.work)).toEqual(['nightly-in-work']);
  });
});

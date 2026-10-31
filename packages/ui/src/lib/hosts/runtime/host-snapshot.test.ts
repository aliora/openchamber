import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { createHostSnapshotProjector, type HostSnapshotInput } from './host-snapshot';

const session = (id: string, directory = '/repo/app'): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const input = (overrides: Partial<HostSnapshotInput> = {}): HostSnapshotInput => ({
  activeSessions: [session('ses_a'), session('ses_b')],
  hasLoaded: true,
  listStatus: 'ready',
  statusById: new Map(),
  pendingBySession: new Map(),
  projects: null,
  defaultProjectId: null,
  ...overrides,
});

describe('projecting a host runtime into a sidebar snapshot', () => {
  test('the same inputs give the same snapshot object', () => {
    const project = createHostSnapshotProjector();
    const first = input();
    expect(project(first, 10)).toBe(project({ ...first }, 20));
  });

  test('a change to one session keeps the other rows', () => {
    const project = createHostSnapshotProjector();
    const before = project(input(), 10);
    const after = project(input({ statusById: new Map([['ses_b', { status: { type: 'busy' } }]]) }), 20);

    expect(after).not.toBe(before);
    expect(after.sessions.get('ses_a')).toBe(before.sessions.get('ses_a'));
    expect(after.sessions.get('ses_b')?.state).toBe('running');
    expect(after.lastCompleteAt).toBe(10);
  });

  test('In work comes from the session in the host\'s own store, and a change of it replaces the row', () => {
    const project = createHostSnapshotProjector();
    const tracked: Session = { ...session('ses_a'), metadata: { openchamber: { work: { state: 'open', openedAt: 1 } } } };
    const before = project(input({ activeSessions: [tracked, session('ses_b')] }), 10);
    expect(before.sessions.get('ses_a')?.work).toBe('open');
    expect(before.sessions.get('ses_b')?.work).toBeNull();

    const done: Session = { ...tracked, metadata: { openchamber: { work: { state: 'done', doneAt: 2 } } } };
    const after = project(input({ activeSessions: [done, session('ses_b')] }), 20);
    expect(after.sessions.get('ses_a')?.work).toBeNull();
    expect(after.sessions.get('ses_b')).toBe(before.sessions.get('ses_b'));
  });

  test('unread comes from the view watermark the host keeps for every client, and a view replaces the row', () => {
    const project = createHostSnapshotProjector();
    const finished: Session = { ...session('ses_a'), time: { created: 1, updated: 2, idle: 5, viewed: 3 } };
    const before = project(input({ activeSessions: [finished, session('ses_b')] }), 10);
    expect(before.sessions.get('ses_a')?.unread).toBe(true);
    expect(before.sessions.get('ses_b')?.unread).toBeUndefined();

    const seen: Session = { ...finished, time: { ...finished.time, viewed: 5 } };
    const after = project(input({ activeSessions: [seen, session('ses_b')] }), 20);
    expect(after.sessions.get('ses_a')?.unread).toBeUndefined();
    expect(after.sessions.get('ses_b')).toBe(before.sessions.get('ses_b'));
  });

  test('a pin comes from the session metadata every client shares, and a change of it replaces the row', () => {
    const project = createHostSnapshotProjector();
    const pinned: Session = { ...session('ses_a'), metadata: { openchamber: { pinned: { at: 1 } } } };
    const before = project(input({ activeSessions: [pinned, session('ses_b')] }), 10);
    expect(before.sessions.get('ses_a')?.pinned).toBe(true);
    expect(before.sessions.get('ses_b')?.pinned).toBeUndefined();

    const after = project(input({ activeSessions: [session('ses_a'), session('ses_b')] }), 20);
    expect(after.sessions.get('ses_a')?.pinned).toBeUndefined();
    expect(after.sessions.get('ses_b')).toBe(before.sessions.get('ses_b'));
  });

  test('a scheduled run comes from the session metadata, and toggling it replaces the row', () => {
    const project = createHostSnapshotProjector();
    const scheduled: Session = { ...session('ses_a'), metadata: { openchamber: { kind: 'scheduled' } } };
    const before = project(input({ activeSessions: [scheduled, session('ses_b')] }), 10);
    expect(before.sessions.get('ses_a')?.scheduled).toBe(true);
    expect(before.sessions.get('ses_b')?.scheduled).toBeUndefined();

    const same = project(input({ activeSessions: [{ ...scheduled }, session('ses_b')] }), 20);
    expect(same).toBe(before);

    const after = project(input({ activeSessions: [session('ses_a'), session('ses_b')] }), 30);
    expect(after).not.toBe(before);
    expect(after.sessions.get('ses_a')?.scheduled).toBeUndefined();
    expect(after.sessions.get('ses_a')).not.toBe(before.sessions.get('ses_a'));
    expect(after.sessions.get('ses_b')).toBe(before.sessions.get('ses_b'));
  });

  test('a pending permission or form wins over a running turn', () => {
    const project = createHostSnapshotProjector();
    const snapshot = project(input({
      statusById: new Map([['ses_a', { status: { type: 'busy' } }], ['ses_b', { status: { type: 'busy' } }]]),
      pendingBySession: new Map([
        ['ses_a', { permissions: [{ id: 'per_1' }], forms: [], pages: [] }],
        ['ses_b', { permissions: [], forms: [{ id: 'form_1' }], pages: [] }],
      ]),
    }), 10);

    expect(snapshot.sessions.get('ses_a')?.state).toBe('waiting-permission');
    expect(snapshot.sessions.get('ses_b')?.state).toBe('waiting-input');
  });

  test('a failed list keeps the sessions it had and says it is stale', () => {
    const project = createHostSnapshotProjector();
    const ready = project(input(), 10);
    const failed = project(input({ listStatus: 'error' }), 20);

    expect(failed.status).toBe('error');
    expect(failed.sessions).toBe(ready.sessions);
    expect(project(input({ hasLoaded: false, listStatus: 'loading', activeSessions: [] }), 30).status).toBe('loading');
  });

  test('sessions name the deepest project that holds their folder only once projects are known', () => {
    const project = createHostSnapshotProjector();
    const unknown = project(input(), 10);
    expect(unknown.projects).toBeUndefined();
    expect('projectId' in (unknown.sessions.get('ses_a') ?? {})).toBe(false);

    const known = project(input({
      projects: [{ id: 'repo', path: '/repo' }, { id: 'app', path: '/repo/app' }],
      defaultProjectId: 'repo',
      activeSessions: [session('ses_a'), session('ses_c', '/elsewhere')],
    }), 20);
    expect(known.sessions.get('ses_a')?.projectId).toBe('app');
    expect(known.sessions.get('ses_c')?.projectId).toBeNull();
    expect(known.projects?.map((entry) => [entry.id, entry.label, entry.order, entry.isDefault])).toEqual([
      ['repo', 'repo', 0, true],
      ['app', 'app', 1, false],
    ]);
  });

  test('a row carries the provider of the session model so the sidebar shows its logo', () => {
    const project = createHostSnapshotProjector();
    const withModel: Session = { ...session('ses_a'), model: { providerID: 'anthropic', id: 'claude-sonnet' } };
    const first = project(input({ activeSessions: [withModel, session('ses_b')] }), 10);
    expect(first.sessions.get('ses_a')?.providerId).toBe('anthropic');
    expect(first.sessions.get('ses_b')?.providerId).toBeUndefined();

    const switched: Session = { ...withModel, model: { providerID: 'openai', id: 'gpt' } };
    const second = project(input({ activeSessions: [switched, session('ses_b')] }), 20);
    expect(second.sessions.get('ses_a')?.providerId).toBe('openai');
    expect(second.sessions.get('ses_b')).toBe(first.sessions.get('ses_b'));
  });
});


import { describe, expect, test } from 'bun:test';
import type { HostDescriptor, HostProject, HostSessionSummary, MonitoredHost } from '@/lib/hosts/types';
import { projectMonitoredHost, remoteSessionMatchesQuery, isRemoteScheduledRun, selectRemoteAttention, selectRemoteRunning, selectRemoteScheduled } from './remoteHostProjection';

const descriptor = (id: string): HostDescriptor => ({
  id,
  label: id,
  kind: 'direct',
  displayUrl: `https://${id}.example`,
  runtimeKey: `host:${id}`,
  monitored: true,
});

const row = (id: string, extra: Partial<HostSessionSummary> = {}): HostSessionSummary => ({
  id,
  title: `Title ${id}`,
  directory: '/work/app',
 
  updatedAt: 1,
  state: 'idle',
  work: null,
  ...extra,
});

const host = (id: string, rows: HostSessionSummary[], projects?: HostProject[]): MonitoredHost => ({
  descriptor: descriptor(id),
  connection: { state: 'live', since: 1, via: 'stream' },
  snapshot: { status: 'ready', sessions: new Map(rows.map((entry) => [entry.id, entry])), lastCompleteAt: 1, projects },
});

describe('projectMonitoredHost', () => {
  test('lists top-level sessions newest first with their subsessions nested under them, newest first', () => {
    const projected = projectMonitoredHost(host('studio', [
      row('old', { directory: '/work/api', updatedAt: 10 }),
      row('chat', { directory: '/chats/2026-10-16/session-1', chat: true, updatedAt: 20 }),
      row('new', { directory: '/work/app', updatedAt: 30 }),
      row('child-1', { parentID: 'new', updatedAt: 40 }),
      row('child-2', { parentID: 'new', updatedAt: 41 }),
      row('grandchild', { parentID: 'child-1', updatedAt: 42 }),
      row('orphan', { parentID: 'gone', directory: '/work/api', updatedAt: 5 }),
    ]));
    expect(projected.sessions.map((item) => item.session.id)).toEqual(['new', 'chat', 'old', 'orphan']);
    const [parent] = projected.sessions;
    expect(parent?.children.map((item) => item.session.id)).toEqual(['child-2', 'child-1']);
    expect(parent?.children[1]?.children.map((item) => item.session.id)).toEqual(['grandchild']);
  });

  test('a host without sessions or projects has nowhere to start one', () => {
    expect(projectMonitoredHost(host('studio', [])).newSessionDirectory).toBeNull();
  });

  test('ranks a row like a local one: a subsession\'s request waits for the run, its failure does not', () => {
    const projected = projectMonitoredHost(host('studio', [
      row('asks', { updatedAt: 6 }),
      row('asks-child', { parentID: 'asks', state: 'waiting-permission' }),
      row('question', { state: 'waiting-input', updatedAt: 5 }),
      row('failed', { state: 'failed', unread: true, updatedAt: 4 }),
      row('failed-seen', { state: 'failed', updatedAt: 4 }),
      row('finished', { unread: true, updatedAt: 4 }),
      row('child-failed', { updatedAt: 3 }),
      row('child-failed-sub', { parentID: 'child-failed', state: 'failed' }),
      row('subagent', { updatedAt: 2 }),
      row('subagent-child', { parentID: 'subagent', state: 'running' }),
      row('running', { state: 'running', updatedAt: 1 }),
    ]));
    const states = new Map(projected.sessions.map((item) => [item.session.id, item.liveState]));
    expect(Object.fromEntries(states)).toEqual({
      asks: 'waiting-permission',
      question: 'waiting-input',
      failed: 'failed',
      'failed-seen': 'idle',
      finished: 'unread',
      'child-failed': 'idle',
      subagent: 'subagent',
      running: 'running',
    });

    // "Needs you" takes only what waits on the user, never a failure.
    expect(selectRemoteAttention([projected]).map((item) => item.session.id)).toEqual(['asks', 'question']);
    expect(selectRemoteRunning([projected]).map((item) => item.session.id)).toEqual(['subagent', 'running']);
  });

  test('selectRemoteScheduled lists scheduled runs that are not pinned, newest first', () => {
    const studio = projectMonitoredHost(host('studio', [
      row('manual', { work: 'open', updatedAt: 1 }),
      row('nightly', { work: 'open', scheduled: true, updatedAt: 5 }),
      row('pinned-run', { work: 'open', scheduled: true, pinned: true, updatedAt: 6 }),
    ]));
    const laptop = projectMonitoredHost(host('laptop', [
      row('weekly', { scheduled: true, updatedAt: 9 }),
      row('plain', { updatedAt: 10 }),
    ]));

    expect(selectRemoteScheduled([studio, laptop]).map((item) => `${item.host.id}:${item.session.id}`)).toEqual([
      'laptop:weekly', 'studio:nightly',
    ]);
  });

  test('isRemoteScheduledRun is false for a pinned or unscheduled row', () => {
    const [scheduled, pinned, plain] = projectMonitoredHost(host('studio', [
      row('scheduled', { scheduled: true, updatedAt: 3 }),
      row('pinned', { scheduled: true, pinned: true, updatedAt: 2 }),
      row('plain', { updatedAt: 1 }),
    ])).sessions;
    if (!scheduled || !pinned || !plain) throw new Error('missing session');
    expect(isRemoteScheduledRun(scheduled)).toBe(true);
    expect(isRemoteScheduledRun(pinned)).toBe(false);
    expect(isRemoteScheduledRun(plain)).toBe(false);
  });

  test('keeps the projection of a host entry that did not change', () => {
    const entry = host('studio', [row('a')]);
    expect(projectMonitoredHost(entry)).toBe(projectMonitoredHost(entry));
    expect(projectMonitoredHost({ ...entry })).not.toBe(projectMonitoredHost(entry));
  });
});

describe('remoteSessionMatchesQuery', () => {
  const [item] = projectMonitoredHost(host('studio', [row('ses_Abc', { title: 'Fix login' })])).sessions;
  if (!item) throw new Error('no session');

  test('matches the title, or the exact id for a ses_ query', () => {
    expect(remoteSessionMatchesQuery(item, 'login')).toBe(true);
    expect(remoteSessionMatchesQuery(item, 'ses_abc')).toBe(true);
    expect(remoteSessionMatchesQuery(item, 'ses_ab')).toBe(false);
    expect(remoteSessionMatchesQuery(item, 'logout')).toBe(false);
  });
});

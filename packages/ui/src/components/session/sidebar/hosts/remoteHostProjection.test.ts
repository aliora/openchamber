import { describe, expect, test } from 'bun:test';
import type { HostDescriptor, HostProject, HostSessionSummary, MonitoredHost } from '@/lib/hosts/types';
import { projectMonitoredHost, remoteSessionMatchesQuery, selectRemoteAttention, selectRemoteRunning } from './remoteHostProjection';

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
  engine: 'claude',
  updatedAt: 1,
  state: 'idle',
  ...extra,
});

const host = (id: string, rows: HostSessionSummary[], projects?: HostProject[]): MonitoredHost => ({
  descriptor: descriptor(id),
  connection: { state: 'live', since: 1, via: 'stream' },
  snapshot: { status: 'ready', sessions: new Map(rows.map((entry) => [entry.id, entry])), lastCompleteAt: 1, generation: 1, projects },
});

const project = (id: string, order: number, extra: Partial<HostProject> = {}): HostProject => ({
  id, label: id.toUpperCase(), path: `/work/${id}`, order, isDefault: false, ...extra,
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
    expect(projected.sessions[0]?.folderLabel).toBe('app');
    expect(projected.sessions[1]?.folderLabel).toBeNull();
  });

  test('marks rows outside the default project with their project or folder, and starts new sessions in the default project', () => {
    const projected = projectMonitoredHost(host('studio', [
      row('api', { projectId: 'api', directory: '/work/api/pkg', updatedAt: 9 }),
      row('web', { projectId: 'web', directory: '/work/web', updatedAt: 2 }),
      row('chat', { chat: true, projectId: null, directory: '/chats/1', updatedAt: 3 }),
      row('loose', { projectId: null, directory: '/tmp/x', updatedAt: 8 }),
      row('api-child', { parentID: 'api', projectId: 'web', directory: '/work/web', updatedAt: 10 }),
    ], [project('web', 0), project('api', 2, { isDefault: true })]));
    expect(Object.fromEntries(projected.sessions.map((item) => [item.session.id, item.projectChip]))).toEqual({
      api: null,
      web: 'WEB',
      chat: null,
      loose: 'x',
    });
    expect(projected.sessions[0]?.children[0]?.projectChip).toBeNull();
    expect(projected.newSessionDirectory).toBe('/work/api');
  });

  test('a host that sends no projects treats the folder with the most sessions as its main one', () => {
    const projected = projectMonitoredHost(host('studio', [
      row('a', { directory: '/work/app', updatedAt: 1 }),
      row('b', { directory: '/work/app', updatedAt: 2 }),
      row('c', { directory: '/work/api', updatedAt: 3 }),
    ]));
    expect(projected.sessions.map((item) => [item.session.id, item.projectChip])).toEqual([['c', 'api'], ['b', null], ['a', null]]);
    expect(projected.newSessionDirectory).toBe('/work/app');
  });

  test('a host without sessions or projects has nowhere to start one', () => {
    expect(projectMonitoredHost(host('studio', [])).newSessionDirectory).toBeNull();
  });

  test('ranks a row like a local one: a subsession\'s request waits for the run, its failure does not', () => {
    const projected = projectMonitoredHost(host('studio', [
      row('asks', { updatedAt: 6 }),
      row('asks-child', { parentID: 'asks', state: 'waiting-permission' }),
      row('question', { state: 'waiting-input', updatedAt: 5 }),
      row('failed', { state: 'failed', updatedAt: 4 }),
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
      'child-failed': 'idle',
      subagent: 'subagent',
      running: 'running',
    });

    // "Needs you" takes what waits on the user; a host cannot say whether a failure was seen.
    expect(selectRemoteAttention([projected]).map((item) => item.session.id)).toEqual(['asks', 'question']);
    expect(selectRemoteRunning([projected]).map((item) => item.session.id)).toEqual(['subagent', 'running']);
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

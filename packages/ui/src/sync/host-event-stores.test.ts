import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { runWithHost } from '@/lib/hosts/runtime/ambient-host';
import { hostRegistry, resolveHost } from '@/lib/hosts/runtime/app-host';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import type { SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { PermissionRequest, Session } from '@/lib/opencode/model';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { usePermissionStore } from '@/stores/permissionStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyBackgroundShellEvents, useBackgroundShellsStore } from './background-shells';
import { ChildStoreManager } from './child-store';
import { applyGlobalBlockingRequestEvents, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { applyGlobalSessionStatusEvents, useGlobalSessionStatusStore } from './global-session-status';
import { useGlobalSyncStore } from './global-sync-store';
import { useSessionActivityTimingStore } from './session-activity-timing';
import { useSessionOrderingStore } from './session-ordering';
import { getDirectoryState, getSyncChildStores, setSyncRefs } from './sync-refs';

const session = (id: string): Session => ({
  id, projectID: 'project', directory: '/repo', title: id, time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const permission = (sessionID: string): PermissionRequest => ({ id: `perm_${sessionID}`, sessionID, action: 'bash', resources: ['rm *'], metadata: {} });

const turnEvents = (sessionID: string): SyncEvent[] => [
  { type: 'shell.started', properties: { shell: { id: `shell_${sessionID}`, sessionID, command: 'sleep 9', file: '/tmp/out', startedAt: 1 } } },
  { type: 'permission.asked', properties: permission(sessionID) },
  // The turn's start comes with its status; a bare busy status names no start.
  { type: 'session.status', properties: { sessionID, status: { type: 'busy' }, turnStart: { at: 1, source: 'live' } } },
];

const applyTurn = (sessionID: string): void => {
  const events = turnEvents(sessionID);
  applyBackgroundShellEvents('/repo', events);
  applyGlobalBlockingRequestEvents('/repo', events);
  applyGlobalSessionStatusEvents('/repo', events);
  useGlobalSessionsStore.getState().upsertSession(session(sessionID));
  usePermissionStore.getState().applySnapshot({ modes: { [sessionID]: 'auto' }, revision: 1 });
  useGlobalSyncStore.getState().actions.set({ reload: 'pending' });
};

const snapshotOf = (host: HostRuntime) => runWithHost(host, () => ({
  sessions: useGlobalSessionsStore.getState(),
  status: useGlobalSessionStatusStore.getState(),
  blocking: useGlobalBlockingRequestsStore.getState(),
  shells: useBackgroundShellsStore.getState(),
  ordering: useSessionOrderingStore.getState(),
  timing: useSessionActivityTimingStore.getState(),
  permission: usePermissionStore.getState(),
  sync: useGlobalSyncStore.getState(),
}));

const expectSameStates = (actual: ReturnType<typeof snapshotOf>, expected: ReturnType<typeof snapshotOf>): void => {
  expect(actual.sessions).toBe(expected.sessions);
  expect(actual.status).toBe(expected.status);
  expect(actual.blocking).toBe(expected.blocking);
  expect(actual.shells).toBe(expected.shells);
  expect(actual.ordering).toBe(expected.ordering);
  expect(actual.timing).toBe(expected.timing);
  expect(actual.permission).toBe(expected.permission);
  expect(actual.sync).toBe(expected.sync);
};

const expectFreshEventStores = (): void => {
  expect(useGlobalSessionsStore.getState().entityById.size).toBe(0);
  expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
  expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
  expect(useGlobalBlockingRequestsStore.getState().bySession.size).toBe(0);
  expect(useBackgroundShellsStore.getState().byId.size).toBe(0);
  expect(useSessionOrderingStore.getState().rankById.size).toBe(0);
  expect(useSessionActivityTimingStore.getState().startedAt.size).toBe(0);
  expect(usePermissionStore.getState().modes).toEqual({});
  expect(useGlobalSyncStore.getState().reload).toBeUndefined();
  expect(getDirectoryState('/repo')).toBeUndefined();
};

describe('the stores the event reducer writes', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('keep one copy per host: events applied for one host leave the other host\'s state as it was', () => {
    const focused = resolveHost();
    const other = hostRegistry.register({
      descriptor: { id: 'host:other', label: 'host:other', kind: 'direct', displayUrl: 'https://other.example/', runtimeKey: 'host:other', monitored: false },
      endpoint: { kind: 'direct', apiUrl: 'https://other.example' },
    }, async () => null);
    try {
      runWithHost(focused, () => applyTurn('ses_focused'));
      const focusedBefore = snapshotOf(focused);
      const otherBefore = snapshotOf(other);

      const children = new ChildStoreManager();
      children.ensureChild('/repo', { bootstrap: false });
      runWithHost(other, () => {
        applyTurn('ses_other');
        setSyncRefs(other.client.getSdkClient(), children, '/repo');
      });

      expectSameStates(snapshotOf(focused), focusedBefore);
      const otherAfter = snapshotOf(other);
      expect(otherAfter.status).not.toBe(otherBefore.status);
      expect([...otherAfter.status.activeSessionIds]).toEqual(['ses_other']);
      expect([...otherAfter.blocking.bySession.keys()]).toEqual(['ses_other']);
      expect([...otherAfter.shells.sessionIds]).toEqual(['ses_other']);
      expect([...otherAfter.ordering.rankById.keys()]).toEqual(['ses_other']);
      expect([...otherAfter.timing.startedAt.keys()]).toEqual(['ses_other']);
      expect(otherAfter.sessions.entityById.has('ses_focused')).toBe(false);
      expect(otherAfter.permission.modes).toEqual({ ses_other: 'auto' });
      expect(runWithHost(other, getSyncChildStores)).toBe(children);
      expect(() => runWithHost(focused, getSyncChildStores)).toThrow();
      expect([...useGlobalSessionStatusStore.getState().activeSessionIds]).toEqual(['ses_focused']);
    } finally {
      hostRegistry.unregister(other.id);
    }
  });

  test('start empty for the host a runtime switch moves to, and keep their state for a same-host switch', () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://first.example', runtimeKey: 'host:first' });
    applyTurn('ses_first');
    setSyncRefs(resolveHost().client.getSdkClient(), new ChildStoreManager(), '/repo');
    resolveHost().run(() => getSyncChildStores().ensureChild('/repo', { bootstrap: false }));
    const first = snapshotOf(resolveHost());

    switchRuntimeEndpoint({ apiBaseUrl: 'https://first.example', runtimeKey: 'host:first', clientToken: 'fresh' });
    expectSameStates(snapshotOf(resolveHost()), first);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://second.example', runtimeKey: 'host:second' });
    expect(hostRegistry.list().map((host) => host.id)).toEqual(['host:second']);
    expectFreshEventStores();
  });

  test('drop a global session load that a runtime switch overtook', async () => {
    const originalListSessionsPage = opencodeClient.listSessionsPage;
    const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
    let markListing: () => void = () => undefined;
    const listing = new Promise<void>((resolve) => { markListing = resolve; });
    let releaseList: (sessions: Session[]) => void = () => undefined;
    const listed = new Promise<Session[]>((resolve) => { releaseList = resolve; });
    opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
    opencodeClient.listSessionsPage = async () => {
      markListing();
      return { sessions: await listed, cursor: {} };
    };
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://third.example', runtimeKey: 'host:third' });
      const overtaken = useGlobalSessionsStore.forHost('host:third');
      const load = overtaken.getState().loadSessions();
      await listing;
      switchRuntimeEndpoint({ apiBaseUrl: 'https://fourth.example', runtimeKey: 'host:fourth' });
      releaseList([session('ses_third')]);

      expect(await load).toEqual({ activeSessions: [], archivedSessions: [] });
      expect(overtaken.getState().hasLoaded).toBe(false);
      expect(useGlobalSessionsStore.getState().entityById.has('ses_third')).toBe(false);
    } finally {
      opencodeClient.listSessionsPage = originalListSessionsPage;
      opencodeClient.getFilesystemHomeInfo = originalHomeInfo;
    }
  });
});

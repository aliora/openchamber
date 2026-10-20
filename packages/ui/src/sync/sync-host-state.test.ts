import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { toast } from '@/components/ui';
import { hostRegistry, resolveHost } from '@/lib/hosts/runtime/app-host';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import type { SyncEvent } from '@/lib/opencode/events';
import type { PermissionRequest, Session } from '@/lib/opencode/model';
import { reportHostViewerState } from '@/lib/surfaceAttention';
import { ChildStoreManager } from './child-store';
import { syncHostStateOf } from './sync-host-state';
import { createEventRoutingIndex, handleEvent, setActiveSession } from './sync-context';

const session = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: 'project', directory: '/repo', title: id, time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const permissionAsked = (id: string): SyncEvent => {
  const permission: PermissionRequest = { id, sessionID: 'ses_viewed', action: 'bash', resources: ['rm *'], metadata: {} };
  return { type: 'permission.asked', properties: permission };
};

const childStoresWithSessions = (): ChildStoreManager => {
  const children = new ChildStoreManager();
  children.ensureChild('/repo', { bootstrap: false }).setState({
    session: [session('ses_parent'), session('ses_child', 'ses_parent'), session('ses_viewed')],
  });
  return children;
};

const receive = (host: HostRuntime, directory: string, event: SyncEvent, children: ChildStoreManager): void => {
  host.run(() => handleEvent(directory, event, children, createEventRoutingIndex(), host.id));
};

const clearCatalogTimer = (host: HostRuntime): void => {
  const { catalogReload } = syncHostStateOf(host);
  if (catalogReload.timer) clearTimeout(catalogReload.timer);
  catalogReload.timer = null;
};

describe('sync state per host', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let focused: HostRuntime;
  let other: HostRuntime;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    reportHostViewerState({ windowFocused: true, surfaceVisible: true });
  });

  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const registerOther = (): void => {
    focused = resolveHost();
    other = hostRegistry.register({
      descriptor: { id: 'host:other', label: 'host:other', kind: 'direct', displayUrl: 'https://other.example/', runtimeKey: 'host:other', monitored: false },
      endpoint: { kind: 'direct', apiUrl: 'https://other.example' },
    }, async () => null);
  };

  afterEach(() => {
    if (focused) {
      clearCatalogTimer(focused);
      hostRegistry.focus(focused.id);
    }
    if (other) {
      clearCatalogTimer(other);
      hostRegistry.unregister(other.id);
    }
  });

  test('two hosts keep their own catalog reload batch', () => {
    registerOther();
    const children = new ChildStoreManager();

    receive(focused, '/focused', { type: 'catalog.updated', properties: { kind: 'agent' } }, children);
    receive(other, '/other', { type: 'catalog.updated', properties: { kind: 'agent' } }, children);

    const focusedBatch = syncHostStateOf(focused).catalogReload;
    const otherBatch = syncHostStateOf(other).catalogReload;
    expect([...(focusedBatch.directoriesByKind.get('agent') ?? [])]).toEqual(['/focused']);
    expect([...(otherBatch.directoriesByKind.get('agent') ?? [])]).toEqual(['/other']);
    expect(focusedBatch.runtime?.host).toBe(focused);
    expect(otherBatch.runtime?.host).toBe(other);
    expect(focusedBatch.timer).not.toBeNull();
    expect(otherBatch.timer).not.toBeNull();
  });

  test('two hosts keep their own materialization cooldowns', () => {
    registerOther();
    const idle: SyncEvent = { type: 'session.idle', properties: { sessionID: 'ses_child' } };

    receive(focused, '/repo', idle, childStoresWithSessions());
    receive(other, '/repo', idle, childStoresWithSessions());

    expect(syncHostStateOf(focused).pendingMaterializations.size).toBe(1);
    expect(syncHostStateOf(other).pendingMaterializations.size).toBe(1);
    expect([...syncHostStateOf(other).pendingMaterializations.keys()])
      .not.toEqual([...syncHostStateOf(focused).pendingMaterializations.keys()]);
  });

  test('a permission of another host is not hidden by the session this host shows', () => {
    registerOther();
    const shown = spyOn(toast, 'info').mockImplementation(() => 'toast');
    try {
      focused.run(() => setActiveSession('/repo', 'ses_viewed'));

      receive(focused, '/repo', permissionAsked('perm_focused'), childStoresWithSessions());
      expect(shown.mock.calls.length).toBe(0);

      receive(other, '/repo', permissionAsked('perm_other'), childStoresWithSessions());
      expect(shown.mock.calls.length).toBe(1);

      hostRegistry.focus(other.id);
      receive(focused, '/repo', permissionAsked('perm_unfocused'), childStoresWithSessions());
      expect(shown.mock.calls.length).toBe(2);
    } finally {
      shown.mockRestore();
      focused.run(() => setActiveSession('', ''));
    }
  });
});

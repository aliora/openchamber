import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { hostRegistry, resolveHost } from '@/lib/hosts/runtime/app-host';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshSpaceArchives, useSpaceArchivesStore } from '@/lib/spaces/space-archives';
import { isSpaceCreationRequest } from '@/lib/spaces/space-creation';
import { noteSpaceModelAccess, spaceModelRefusal } from '@/lib/spaces/space-model-access';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { resolveProjectContextId } from '@/lib/projectContextApi';
import { usePermissionStore } from '@/stores/permissionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { flushPendingSessionWrites, persistGlobalSessionSnapshot } from './persist-cache';
import { observeSessionActivityTiming } from './session-activity-timing';
import { useSessionUIStore } from './session-ui-store';

const SPACE_ID = '0123456789ab';
const PROJECT = { id: 'project', path: '/repo' };
const PROJECT_ID = resolveProjectContextId(PROJECT);
const LOADED_PROJECT = { id: 'loaded', path: '/repo/loaded' };
const LOADED_PROJECT_ID = resolveProjectContextId(LOADED_PROJECT);

const spaceEntry: SpaceEntry = {
  id: SPACE_ID, name: 'space', placeId: 'docker', machine: null, projectDirectory: '/repo', directory: `/spaces/${SPACE_ID}/repo`,
  projectFolder: { path: '/repo', found: true }, state: 'running', stoppedIdle: false, step: null, failure: null, network: null,
  grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
};

const hostNamed = (id: string) => ({
  descriptor: { id, label: id, kind: 'direct' as const, displayUrl: `https://${id}.example/`, runtimeKey: id, monitored: false },
  endpoint: { kind: 'direct' as const, apiUrl: `https://${id}.example` },
});

const registerHost = (id: string): HostRuntime => hostRegistry.register(hostNamed(id), async () => null);

const session = (id: string): Session => ({
  id, projectID: 'project', directory: '/repo', title: id, time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const flushDeferredWrites = async (): Promise<void> => {
  flushPendingSessionWrites();
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

type Gate = { release: (json: string) => void; started: Promise<void> };

const gateRoute = (path: string): Gate => {
  let release: (json: string) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const body = new Promise<string>((resolve) => { release = resolve; });
  routes.set(path, async () => {
    markStarted();
    return new Response(await body, { headers: { 'Content-Type': 'application/json' } });
  });
  return { release, started };
};

const routes = new Map<string, () => Promise<Response>>();

const windowStorage = new Map<string, string>();

const storageKeys = (prefix: string): string[] => {
  const storage = getSafeStorage();
  const keys = new Set([...windowStorage.keys()].filter((key) => key.startsWith(prefix)));
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.add(key);
  }
  return [...keys].sort();
};

describe('the stores that serve one host at a time', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeAll(async () => {
    const respond = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
      const route = routes.get(path);
      return route ? route() : new Response(null, { status: 404 });
    };
    globalThis.fetch = Object.assign(respond, { preconnect: async () => {} });
    const storage = windowStorage;
    const localStorage: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => { storage.clear(); },
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage }) });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' });
    const homeInfo = opencodeClient.getFilesystemHomeInfo;
    opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
    await ensureChatsRootDirectory();
    opencodeClient.getFilesystemHomeInfo = homeInfo;
  });

  afterEach(() => {
    routes.clear();
    for (const host of hostRegistry.list()) {
      if (host.id !== 'host:a') hostRegistry.unregister(host.id);
    }
    if (hostRegistry.get('host:a')) hostRegistry.focus('host:a');
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('keep one copy per host: what the focused host holds never shows on another host', () => {
    const a = resolveHost();
    a.run(() => {
      useSessionUIStore.setState({ currentSessionId: 'ses_a', currentSessionDirectory: '/repo' });
      useDirectoryStore.getState().setDirectory('/repo/a');
      useProjectsStore.setState({ activeProjectId: 'project-a' });
      useProjectContextStore.setState({ entries: { [PROJECT_ID]: { notes: [], todos: [], plans: [], sharedPlansDir: null, loaded: true, loading: false, error: null } } });
      useSpacesStore.getState().addJourneyEntry(spaceEntry);
    });
    const b = registerHost('host:b');

    b.run(() => {
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      useDirectoryStore.getState().setDirectory('/repo/b');
      expect(useProjectsStore.getState().activeProjectId).not.toBe('project-a');
      expect(useProjectContextStore.getState().entries).toEqual({});
      expect(useSpacesStore.getState().journey).toBeNull();
      expect(useSpaceArchivesStore.getState().byDirectory).toBeNull();
    });
    a.run(() => {
      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_a');
      expect(useDirectoryStore.getState().currentDirectory).toBe('/repo/a');
      expect(useSpacesStore.getState().journey?.has(SPACE_ID)).toBe(true);
    });
  });

  test('keep what a space creation chose per host', () => {
    const a = resolveHost();
    const b = registerHost('host:b');
    const directory = `/spaces/${SPACE_ID}/repo`;
    a.run(() => noteSpaceModelAccess({ requestId: 'request-a', directory }, ['anthropic']));

    expect(a.run(() => spaceModelRefusal({ requestId: 'request-a', directory: null }, 'openai'))).not.toBeNull();
    expect(b.run(() => spaceModelRefusal({ requestId: 'request-a', directory: null }, 'openai'))).toBeNull();
    expect(b.run(() => isSpaceCreationRequest('request-a'))).toBe(false);
  });

  test('a load that finishes after the focus moved lands in the host that started it', async () => {
    const a = resolveHost();
    const b = registerHost('host:b');
    const contextGate = gateRoute(`/api/project-context/${encodeURIComponent(LOADED_PROJECT_ID)}`);
    const spacesGate = gateRoute('/api/openchamber/spaces');
    const archivesGate = gateRoute('/api/openchamber/spaces/archives');

    const contextLoad = useProjectContextStore.getState().load(LOADED_PROJECT);
    const journeyLoad = refreshSpacesJourney();
    const archivesLoad = refreshSpaceArchives();
    await Promise.all([contextGate.started, spacesGate.started, archivesGate.started]);
    hostRegistry.focus(b.id);

    contextGate.release(JSON.stringify({ notes: [], todos: [{ id: 't1', text: 'from a', done: false }], plans: [] }));
    spacesGate.release(JSON.stringify({ spaces: [] }));
    archivesGate.release(JSON.stringify({ archives: [] }));
    await Promise.all([contextLoad, journeyLoad, archivesLoad]);

    expect(useProjectContextStore.getState().entries[LOADED_PROJECT_ID]).toBeUndefined();
    expect(useSpacesStore.getState().journey).toBeNull();
    expect(useSpaceArchivesStore.getState().byDirectory).toBeNull();
    a.run(() => {
      expect(useProjectContextStore.getState().entries[LOADED_PROJECT_ID]?.todos).toHaveLength(1);
      expect(useSpacesStore.getState().journey?.size).toBe(0);
      expect(useSpaceArchivesStore.getState().byDirectory?.size).toBe(0);
    });
  });

  test('persist each host\'s config under its own key and read it back into a fresh copy', async () => {
    const b = registerHost('host:b');
    useConfigStore.forHost('host:a').setState({ currentProviderId: 'provider-a', currentModelId: 'model-a' });
    useConfigStore.forHost(b.id).setState({ currentProviderId: 'provider-b', currentModelId: 'model-b' });
    await flushDeferredWrites();

    expect(storageKeys('config-store')).toEqual(['config-store:host:a', 'config-store:host:b']);

    hostRegistry.unregister(b.id);
    const rebuilt = registerHost('host:b');
    expect(useConfigStore.forHost(rebuilt.id).getState()).toMatchObject({ currentProviderId: 'provider-b', currentModelId: 'model-b', configRuntimeKey: 'host:b' });
  });

  test('the host the legacy config belongs to adopts it once, and no other host does', async () => {
    const storage = getSafeStorage();
    storage.setItem('config-store', JSON.stringify({ state: { configRuntimeKey: 'host:legacy', currentProviderId: 'legacy-provider', currentModelId: 'legacy-model' }, version: 1 }));

    const other = registerHost('host:other');
    expect(useConfigStore.forHost(other.id).getState().currentProviderId).toBe('');
    expect(storage.getItem('config-store')).not.toBeNull();

    const legacy = registerHost('host:legacy');
    expect(useConfigStore.forHost(legacy.id).getState()).toMatchObject({ currentProviderId: 'legacy-provider', currentModelId: 'legacy-model' });
    expect(storage.getItem('config-store')).toBeNull();
    expect(storage.getItem('config-store:host:legacy')).not.toBeNull();

    await flushDeferredWrites();
    storage.removeItem('config-store:host:legacy');
    hostRegistry.unregister(legacy.id);
    registerHost('host:between');
    const again = registerHost('host:legacy');
    expect(useConfigStore.forHost(again.id).getState().currentProviderId).toBe('');
  });

  test('a malformed config payload, legacy or the host\'s own, leaves the host on defaults', () => {
    const storage = getSafeStorage();
    storage.setItem('config-store', '{not json');
    storage.setItem('config-store:host:broken', 'also not json');
    storage.setItem('config-store:host:invalid', JSON.stringify({ state: 'nope', version: 1 }));

    const broken = registerHost('host:broken');
    const invalid = registerHost('host:invalid');
    expect(useConfigStore.forHost(broken.id).getState().currentProviderId).toBe('');
    expect(useConfigStore.forHost(invalid.id).getState().currentProviderId).toBe('');
    storage.removeItem('config-store');
  });

  test('keep each host\'s persisted session state under its own key', async () => {
    const a = resolveHost();
    const b = registerHost('host:b');
    for (const host of [a, b]) {
      host.run(() => {
        observeSessionActivityTiming(`ses_${host.id}`, 'active');
        persistGlobalSessionSnapshot([session(`ses_${host.id}`)]);
        usePermissionStore.setState({ legacyCandidate: { [`ses_${host.id}`]: true }, legacyRuntimeKey: host.id });
      });
    }
    await flushDeferredWrites();

    expect(storageKeys('oc.session-activity.v1')).toHaveLength(2);
    expect(storageKeys('oc.global-sessions.')).toHaveLength(2);
    expect(storageKeys('permission-store')).toEqual(['permission-store:host:a', 'permission-store:host:b']);
  });

  test('save the global session list of a background host, not only of the focused one', async () => {
    const background = registerHost('host:background');
    hostRegistry.focus('host:a');
    const homeInfo = opencodeClient.getFilesystemHomeInfo;
    opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/user' });
    await background.run(() => ensureChatsRootDirectory());
    opencodeClient.getFilesystemHomeInfo = homeInfo;
    const before = storageKeys('oc.global-sessions.');
    useGlobalSessionsStore.forHost(background.id).getState().upsertSession(session('ses_background'));
    background.run(() => useGlobalSessionsStore.setState({ hasLoaded: true }));
    await flushDeferredWrites();
    expect(storageKeys('oc.global-sessions.').length).toBeGreaterThan(before.length);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { DesktopSettings } from '@/lib/desktop';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { parseSettingsDocument } from '@/lib/settings/registry';

const MAC = 'http://127.0.0.1:3000';
const PI = 'http://192.168.1.56:3000';
const MAC_DIRECTORY = '/Users/me/Documents/Obsidian';
const PI_DIRECTORY = '/home/pi5/agentdocs';
const MAC_PROJECT = { id: 'path_mac', path: MAC_DIRECTORY, label: 'Obsidian' };
const PI_PROJECT = { id: 'path_pi', path: PI_DIRECTORY, label: 'agentdocs' };

const documents = new Map<string, DesktopSettings>([
  [PI, { projects: [PI_PROJECT], activeProjectId: PI_PROJECT.id, lastDirectory: PI_DIRECTORY }],
  [MAC, { projects: [MAC_PROJECT], activeProjectId: MAC_PROJECT.id, lastDirectory: MAC_DIRECTORY }],
]);
const heldWrites = new Map<string, Promise<void>>();

type SeenRequest = { origin: string; method: string; body: string };
const seen: SeenRequest[] = [];
const storage = new Map<string, string>();
const synced: string[] = [];

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  const localStorage: Storage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_API_BASE_URL__: MAC,
      localStorage,
      location: { origin: 'openchamber-ui://app', protocol: 'openchamber-ui:', href: 'openchamber-ui://app/index.html' },
      matchMedia: () => ({ matches: false }),
      setTimeout,
      clearTimeout,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.text();
    seen.push({ origin: url.origin, method: request.method, body });
    if (url.pathname !== '/api/config/settings') return new Response(null, { status: 404 });
    const document = documents.get(url.origin) ?? {};
    if (request.method === 'PUT') {
      await heldWrites.get(url.origin);
      documents.set(url.origin, { ...document, ...parseSettingsDocument(JSON.parse(body)) });
    }
    return Response.json(documents.get(url.origin) ?? {});
  };
  globalThis.fetch = Object.assign(respond, { preconnect: async () => {} });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('settings documents of a multi-host window', () => {
  let mac: HostRuntime;
  let pi: HostRuntime;
  let focusRegisteredHost: (id: string) => boolean;

  beforeAll(async () => {
    installWindow();
    const { initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
    initializeRuntimeEndpoint({ apiBaseUrl: MAC, runtimeKey: 'host:mac' });
    await import('@/stores/useProjectsStore');
    const { setMultiHostRuntime } = await import('@/lib/hosts/runtime/multi-host-flag');
    setMultiHostRuntime(true);
    const appHost = await import('@/lib/hosts/runtime/app-host');
    const { hostRegistry, registerHostEndpoint } = appHost;
    focusRegisteredHost = (id) => appHost.focusRegisteredHost(id);
    mac = hostRegistry.focused();
    registerHostEndpoint('host:pi5', { apiBaseUrl: PI });
    const registered = hostRegistry.get('host:pi5');
    if (!registered) throw new Error('Pi5 was not registered');
    pi = registered;
    window.addEventListener('openchamber:settings-synced', (event) => {
      if (event instanceof CustomEvent) synced.push(JSON.stringify(event.detail));
    });
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    for (const [name, descriptor] of [['window', previousWindow], ['localStorage', previousStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('a write a background host saves never lands in the focused host', async () => {
    const { updateDesktopSettings } = await import('./persistence');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    synced.length = 0;
    await pi.run(() => updateDesktopSettings({ lastDirectory: PI_DIRECTORY }));
    await settle();

    const writes = seen.filter((request) => request.method === 'PUT' && request.body.includes(PI_DIRECTORY));
    expect(writes.map((request) => request.origin)).toEqual([PI]);
    expect(synced.filter((detail) => detail.includes(PI_DIRECTORY))).toEqual([]);
    expect(mac.run(() => useProjectsStore.getState().projects).map((project) => project.path)).not.toContain(PI_DIRECTORY);
    expect(storage.get('lastDirectory:host%3Amac')).not.toBe(PI_DIRECTORY);
  });

  test('writes two hosts queue together each go to their own host', async () => {
    const { updateDesktopSettings } = await import('./persistence');
    seen.length = 0;
    await Promise.all([
      mac.run(() => updateDesktopSettings({ lastDirectory: `${MAC_DIRECTORY}/next` })),
      pi.run(() => updateDesktopSettings({ lastDirectory: `${PI_DIRECTORY}/next` })),
    ]);
    await settle();

    const writes = seen.filter((request) => request.method === 'PUT');
    expect(writes.filter((request) => request.origin === PI).every((request) => !request.body.includes(MAC_DIRECTORY))).toBe(true);
    expect(writes.filter((request) => request.origin === MAC).every((request) => !request.body.includes(PI_DIRECTORY))).toBe(true);
    expect(writes.some((request) => request.origin === PI && request.body.includes(`${PI_DIRECTORY}/next`))).toBe(true);
    expect(writes.some((request) => request.origin === MAC && request.body.includes(`${MAC_DIRECTORY}/next`))).toBe(true);
  });

  test('a background host\'s settings read is never served to the focused host', async () => {
    const { invalidateSettingsCache, loadDesktopSettings } = await import('./persistence');
    invalidateSettingsCache();
    const fromPi = pi.run(() => loadDesktopSettings());
    const fromMac = mac.run(() => loadDesktopSettings());
    expect((await fromPi)?.lastDirectory).toBe(`${PI_DIRECTORY}/next`);
    expect((await fromMac)?.lastDirectory).toBe(`${MAC_DIRECTORY}/next`);
  });

  test("a value one host's server holds never suppresses a write to another host", async () => {
    const { updateDesktopSettings } = await import('./persistence');
    const shared = '/srv/shared';
    await mac.run(() => updateDesktopSettings({ lastDirectory: shared }));
    seen.length = 0;
    await pi.run(() => updateDesktopSettings({ lastDirectory: shared }));
    await settle();

    expect(seen.filter((request) => request.method === 'PUT' && request.origin === PI && request.body.includes(shared))).toHaveLength(1);
    expect(documents.get(PI)?.lastDirectory).toBe(shared);
  });

  test("a background host's save in flight when the focus moves still completes on its own host", async () => {
    const { updateDesktopSettings } = await import('./persistence');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    let release: () => void = () => undefined;
    heldWrites.set(PI, new Promise<void>((resolve) => { release = resolve; }));
    seen.length = 0;
    const saving = pi.run(() => updateDesktopSettings({ lastDirectory: `${PI_DIRECTORY}/moved` }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.filter((request) => request.method === 'PUT').map((request) => request.origin)).toEqual([PI]);

    expect(focusRegisteredHost('host:pi5')).toBe(true);
    release();
    heldWrites.delete(PI);

    expect(await saving).toEqual({ ok: true });
    expect(documents.get(PI)?.lastDirectory).toBe(`${PI_DIRECTORY}/moved`);
    seen.length = 0;
    await pi.run(() => updateDesktopSettings({ lastDirectory: `${PI_DIRECTORY}/moved` }));
    expect(seen.filter((request) => request.method === 'PUT')).toEqual([]);
    expect(mac.run(() => useProjectsStore.getState().projects).map((project) => project.path)).not.toContain(PI_DIRECTORY);
    expect(focusRegisteredHost('host:mac')).toBe(true);
  });
});

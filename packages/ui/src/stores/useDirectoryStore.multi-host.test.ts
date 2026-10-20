import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { HostRuntime } from '@/lib/hosts/runtime/types';

/**
 * A multi-host desktop window booting after a run that ended with Pi5
 * focused: the window-wide `lastDirectory` and `homeDirectory` it left behind
 * are Pi5's. The Mac host must start on its own last directory and never send
 * Pi5's path to the Mac server.
 */

const MAC = 'http://127.0.0.1:3000';
const PI = 'http://192.168.1.56:3000';
const MAC_HOME = '/Users/me';
const MAC_DIRECTORY = '/Users/me/Documents/Obsidian';
const PI_HOME = '/home/pi5';
const PI_DIRECTORY = '/home/pi5/agentdocs';
const MSI = 'http://192.168.1.54:3000';
const MSI_HOME = '/home/msi';
const MSI_DIRECTORY = '/home/msi/game';

const storage = new Map<string, string>([
  ['lastDirectory', PI_DIRECTORY],
  ['homeDirectory', PI_HOME],
  ['lastDirectory:host%3Amac', MAC_DIRECTORY],
  ['homeDirectory:host%3Amac', MAC_HOME],
  ['lastDirectory:host%3Amsi', MSI_DIRECTORY],
  ['homeDirectory:host%3Amsi', MSI_HOME],
]);

type SeenRequest = { origin: string; directory: string | null };
const seen: SeenRequest[] = [];

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
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_HOME__: MAC_HOME,
      __OPENCHAMBER_API_BASE_URL__: MAC,
      localStorage,
      location: { origin: 'openchamber-ui://app', protocol: 'openchamber-ui:', href: 'openchamber-ui://app/index.html' },
      matchMedia: () => ({ matches: false }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const header = request.headers.get('x-opencode-directory');
    seen.push({ origin: url.origin, directory: header ? decodeURIComponent(header) : url.searchParams.get('directory') });
    return new Response(null, { status: 404 });
  };
  globalThis.fetch = Object.assign(respond, { preconnect: async () => {} });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('working directories of a multi-host window', () => {
  let mac: HostRuntime;
  let pi: HostRuntime;
  let msi: HostRuntime;

  beforeAll(async () => {
    installWindow();
    const { initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
    initializeRuntimeEndpoint({ apiBaseUrl: MAC, runtimeKey: 'host:mac' });
    await import('@/stores/useDirectoryStore');
    const { setMultiHostRuntime } = await import('@/lib/hosts/runtime/multi-host-flag');
    setMultiHostRuntime(true);
    const { hostRegistry, registerHostEndpoint } = await import('@/lib/hosts/runtime/app-host');
    mac = hostRegistry.focused();
    const register = (id: string, apiBaseUrl: string): HostRuntime => {
      registerHostEndpoint(id, { apiBaseUrl });
      const registered = hostRegistry.get(id);
      if (!registered) throw new Error(`${id} was not registered`);
      return registered;
    };
    pi = register('host:pi5', PI);
    msi = register('host:msi', MSI);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    for (const [name, descriptor] of [['window', previousWindow], ['localStorage', previousStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('the window host never starts on the directory another host left', async () => {
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    const { opencodeClient } = await import('@/lib/opencode/client');
    expect(mac.id).toBe('host:mac');
    expect(mac.run(() => useDirectoryStore.getState().currentDirectory)).not.toBe(PI_DIRECTORY);
    expect(mac.run(() => opencodeClient.getDirectory())).not.toBe(PI_DIRECTORY);
  });

  test('restoring the persisted directory reads the focused host\'s own entry', async () => {
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    const { opencodeClient } = await import('@/lib/opencode/client');
    const { applyPersistedDirectoryPreferences } = await import('@/lib/directoryPersistence');
    await applyPersistedDirectoryPreferences();
    expect(mac.run(() => useDirectoryStore.getState().currentDirectory)).toBe(MAC_DIRECTORY);
    expect(mac.run(() => opencodeClient.getDirectory())).toBe(MAC_DIRECTORY);
  });

  test('a host registered beside the window host starts on its own stored directory', async () => {
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    const { opencodeClient } = await import('@/lib/opencode/client');
    expect(msi.run(() => useDirectoryStore.getState())).toMatchObject({ currentDirectory: MSI_DIRECTORY, homeDirectory: MSI_HOME, isHomeReady: true });
    expect(msi.run(() => opencodeClient.getDirectory())).toBe(MSI_DIRECTORY);
    expect(pi.run(() => useDirectoryStore.getState()).currentDirectory).toBe('/');
    expect(pi.run(() => opencodeClient.getDirectory())).toBeUndefined();
  });

  test('a directory opened on one host is stored for that host only', async () => {
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    pi.run(() => useDirectoryStore.getState().setDirectory(PI_DIRECTORY));
    await settle();
    expect(storage.get('lastDirectory:host%3Api5')).toBe(PI_DIRECTORY);
    expect(storage.get('lastDirectory:host%3Amac')).toBe(MAC_DIRECTORY);
    expect(mac.run(() => useDirectoryStore.getState().currentDirectory)).toBe(MAC_DIRECTORY);
  });

  test('no request to a host carries a directory of another host', async () => {
    await settle();
    expect(seen.filter((request) => request.origin === MAC && request.directory?.startsWith(PI_HOME))).toEqual([]);
    expect(seen.filter((request) => request.origin === PI && request.directory?.startsWith(MAC_HOME))).toEqual([]);
  });
});

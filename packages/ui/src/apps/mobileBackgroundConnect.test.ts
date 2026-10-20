import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { hostRegistry } from '@/lib/hosts/runtime/app-host';
import { setMultiHostRuntime } from '@/lib/hosts/runtime/multi-host-flag';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { autoConnectLastInstance, connectMobileHost } from './mobileConnections';

const STORAGE_KEY = 'openchamber.mobile.connections.v1';
const PI_URL = 'http://192.168.1.56:3000';
const MSI_URL = 'http://192.168.1.54:3000';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

const storageStub = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('the phone with several saved devices', () => {
  const probed: string[] = [];

  beforeEach(() => {
    probed.length = 0;
    setMultiHostRuntime(true);
    const storage = storageStub();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://localhost/') });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        location: { protocol: 'https:', origin: 'https://localhost' },
        Capacitor: { isNativePlatform: () => false },
        localStorage: storage,
      }),
    });
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = String(input);
      probed.push(url);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      if (url.endsWith('/auth/session')) return Response.json({ authenticated: true, scope: 'client' });
      return new Response(null, { status: 404 });
    }, { preconnect: async () => {} });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'pi', label: 'Pi', lastUsedAt: 20, candidates: [{ kind: 'direct', url: PI_URL }] },
      { id: 'msi', label: 'MSI', lastUsedAt: 10, candidates: [{ kind: 'direct', url: MSI_URL }] },
    ]));
    hostRegistry.focused();
  });

  afterEach(() => {
    for (const host of hostRegistry.list()) {
      if (host.id !== hostRegistry.focused().id) hostRegistry.unregister(host.id);
    }
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of [['window', originalWindow], ['localStorage', originalStorage], ['location', originalLocation]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('auto-connect focuses the most recent device and connects the other one beside it', async () => {
    const outcome = await autoConnectLastInstance({ fast: false });
    expect(outcome).toEqual({ status: 'connected' });
    expect(getRuntimeKey()).toBe(PI_URL);
    expect(hostRegistry.focused().id).toBe(PI_URL);

    await waitFor(() => Boolean(hostRegistry.get(MSI_URL)));
    const msi = hostRegistry.get(MSI_URL);
    expect(msi?.transport.endpoint?.apiBaseUrl).toBe(MSI_URL);
    expect(hostRegistry.focused().id).toBe(PI_URL);
    expect(getRuntimeKey()).toBe(PI_URL);
    expect(probed.some((url) => url.startsWith(MSI_URL))).toBe(true);
  });

  test('a device connected moments ago is not probed again when its supervisor asks', async () => {
    await autoConnectLastInstance({ fast: false });
    await waitFor(() => Boolean(hostRegistry.get(MSI_URL)));
    expect(hostRegistry.get(MSI_URL)).toBeDefined();
    const before = probed.filter((url) => url.startsWith(MSI_URL)).length;

    await connectMobileHost({ id: MSI_URL });
    await connectMobileHost({ id: PI_URL });

    expect(probed.filter((url) => url.startsWith(MSI_URL))).toHaveLength(before);
  });
});

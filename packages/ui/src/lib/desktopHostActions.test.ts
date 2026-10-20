import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const MAC = 'http://127.0.0.1:3000';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const previousFetch = globalThis.fetch;

describe('focusing the saved host the window already serves', () => {
  beforeAll(() => {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
    const events = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __OPENCHAMBER_API_BASE_URL__: MAC,
        __OPENCHAMBER_DESKTOP__: {
          invoke: async (command: string) => (command === 'desktop_hosts_get'
            ? { hosts: [{ id: 'host-mac', label: 'Mac', url: MAC }], defaultHostId: 'host-mac' }
            : null),
        },
        location: new URL('https://app.test/'),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      },
    });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://app.test/') });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    for (const [name, descriptor] of [['window', previousWindow], ['location', previousLocation], ['localStorage', previousStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('a window keyed by the host\'s address keeps one runtime for that address', async () => {
    const { initializeRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
    initializeRuntimeEndpoint({ apiBaseUrl: MAC });
    const { setMultiHostRuntime } = await import('@/lib/hosts/runtime/multi-host-flag');
    setMultiHostRuntime(true);
    const { hostRegistry } = await import('@/lib/hosts/runtime/app-host');
    const windowHost = hostRegistry.focused();
    expect(windowHost.id).toBe(`url:${MAC}`);

    const { switchToDesktopHost } = await import('./desktopHostActions');
    await switchToDesktopHost('host-mac');

    expect(hostRegistry.list().map((host) => host.id)).toEqual([windowHost.id]);
    expect(hostRegistry.focused()).toBe(windowHost);
    expect(getRuntimeKey()).toBe(windowHost.id);
  });
});

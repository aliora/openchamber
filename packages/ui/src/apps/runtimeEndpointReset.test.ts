import { afterEach, describe, expect, test } from 'bun:test';
import { installRuntimeEndpointReset, isHostToHostSwitch } from './runtimeEndpointReset';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { hostsMonitoring } from '@/lib/hosts/hosts-monitoring';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { SavedHost } from '@/lib/hosts/types';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
};

// The switch mints a URL auth token in the background; answer it locally so the
// test never reaches the network.
const stubFetch = (): void => {
  // SAFETY: the endpoint switch only calls fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('installRuntimeEndpointReset', () => {
  // #4219: the login screen unmounts App, so a host switch made from it must
  // still move the SDK client; otherwise App mounts against Local with a client
  // that keeps calling the remote and the startup overlay never lifts.
  test('rebinds the SDK client and resets init state without any mounted UI', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
      expect(opencodeClient.getBaseUrl().startsWith('https://remote.example')).toBe(true);

      useConfigStore.setState({ isInitialized: true, isConnected: true });
      switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:4100', runtimeKey: 'local' });

      expect(opencodeClient.getBaseUrl().startsWith('http://127.0.0.1:4100')).toBe(true);
      expect(useConfigStore.getState().isInitialized).toBe(false);
      expect(useConfigStore.getState().isConnected).toBe(false);
    } finally {
      uninstall();
    }
  });

  // The login gate re-applies the same endpoint with a fresh client token after
  // sign-in, while App is unmounted. That must not wipe the host's state.
  test('leaves a same-runtime credential change to App', () => {
    installWindow();
    stubFetch();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    const uninstall = installRuntimeEndpointReset();
    try {
      useConfigStore.setState({ isInitialized: true, isConnected: true });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'fresh-token', runtimeKey: 'remote' });

      expect(useConfigStore.getState().isInitialized).toBe(true);
      expect(useConfigStore.getState().isConnected).toBe(true);
    } finally {
      uninstall();
    }
  });

  test('stops resetting once uninstalled', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://first.example', runtimeKey: 'first' });
    uninstall();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://second.example', runtimeKey: 'second' });

    expect(opencodeClient.getBaseUrl().startsWith('https://first.example')).toBe(true);
  });

  // The host the window switches to stops being monitored, and the one it left
  // starts, through the real switch event and the real monitoring singleton.
  test('hands host monitors over on a change of runtime', async () => {
    installWindow();
    stubFetch();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:4100', runtimeKey: 'local' });
    const uninstall = installRuntimeEndpointReset();
    const savedHost = (id: string, runtimeKey: string, apiUrl: string): SavedHost => ({
      descriptor: { id, label: id, kind: 'direct', displayUrl: apiUrl, runtimeKey, monitored: true },
      endpoint: { kind: 'direct', apiUrl },
    });
    const hosts = [savedHost('local', 'local', 'http://127.0.0.1:4100'), savedHost('remote', 'host:remote', 'https://remote.example')];
    hostsMonitoring.ensure({ listHosts: async () => ({ status: 'ok', hosts }), getCredential: async () => null });
    const monitoredIds = () => useHostsStore.getState().hosts.map((host) => host.descriptor.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(monitoredIds()).toEqual(['remote']);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'host:remote' });
      expect(monitoredIds()).toEqual(['local']);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'fresh-token', runtimeKey: 'host:remote' });
      expect(monitoredIds()).toEqual(['local']);
    } finally {
      hostsMonitoring.stop();
      uninstall();
    }
  });
});

describe('a switch from one host to another', () => {
  const detail = (previousRuntimeKey: string, runtimeKey: string, apiBaseUrl = 'http://192.168.1.57:3000') => ({
    apiBaseUrl,
    previousApiBaseUrl: 'http://192.168.1.56:3000',
    runtimeKey,
    previousRuntimeKey,
  });

  test('is a move between two connected hosts', () => {
    expect(isHostToHostSwitch(detail('http://192.168.1.56:3000', 'http://192.168.1.57:3000'))).toBe(true);
  });

  test('is not a first connect, a disconnect, or a transport change of the same host', () => {
    expect(isHostToHostSwitch(detail('url:default', 'http://192.168.1.57:3000'))).toBe(false);
    expect(isHostToHostSwitch(detail('mobile-disconnected', 'http://192.168.1.57:3000'))).toBe(false);
    expect(isHostToHostSwitch(detail('http://192.168.1.56:3000', 'mobile-disconnected', ''))).toBe(false);
    expect(isHostToHostSwitch(detail('http://192.168.1.56:3000', 'http://192.168.1.56:3000'))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { OpenCodeEvent } from '@opencode/client';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installRuntimeEndpointReset, isHostToHostSwitch } from './runtimeEndpointReset';
import { FocusedHostGate } from '@/components/auth/FocusedHostGate';
import { useComposerDraft } from '@/components/chat/composer/state/useComposerDraft';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { CodeCliCompatibilityGate } from '@/components/update/CodeCliCompatibilityGate';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { I18nProvider } from '@/lib/i18n';
import { hostRegistry } from '@/lib/hosts/runtime/app-host';
import { setMultiHostRuntime } from '@/lib/hosts/runtime/multi-host-flag';
import { installRuntimeHostsMonitoring } from '@/lib/hosts/runtime/runtime-hosts-monitoring';
import { createRuntimeTransport } from '@/lib/hosts/runtime/runtime-transport';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { OpencodeService, opencodeClient } from '@/lib/opencode/client';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { hostsMonitoring } from '@/lib/hosts/hosts-monitoring';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { SavedHost } from '@/lib/hosts/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';

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

type FakeHost = {
  host: HostRuntime;
  requests: () => string[];
  subscriptions: () => number;
};

type Respond = (path: string) => Response;

const NO_EVENTS: OpenCodeEvent[] = [];

const notFound: Respond = (path) => new Response(JSON.stringify({ path }), { status: 404, headers: { 'content-type': 'application/json' } });

const pathOf = (input: string | URL | Request): string => (
  new URL(input instanceof Request ? input.url : input.toString(), 'https://fake.test').pathname
);

const compatibility = (state: 'compatible' | 'incompatible') => Response.json({
  state,
  version: state === 'compatible' ? '2.0.0' : '1.18.30',
  installation: 'managed',
  canInstall: false,
});

const savedHostOf = (id: string, runtimeKey: string, apiUrl: string): SavedHost => ({
  descriptor: { id, label: id, kind: 'direct', displayUrl: apiUrl, runtimeKey, monitored: true },
  endpoint: { kind: 'direct', apiUrl },
});

const registerFakeHost = (name: string, respond: Respond = notFound): FakeHost => {
  const requests: string[] = [];
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: async (input) => {
      const path = pathOf(input);
      requests.push(path);
      return respond(path);
    },
    createTunnel: createRelayTunnelClient,
  });
  transport.reconfigure({ apiBaseUrl: `https://${name}.example` });
  const runtimeKey = `host:${name}`;
  const client = new OpencodeService({ transport, runtimeKey: () => runtimeKey });
  const subscribe = spyOn(client.getSdkClient().event, 'subscribe').mockImplementation((options) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      yield* NO_EVENTS;
    },
  }));
  const host = hostRegistry.register(savedHostOf(name, runtimeKey, `https://${name}.example`), async () => null, { transport, client });
  useConfigStore.forHost(host.id).setState({ settingsMessageStreamTransport: 'sse' });
  return { host, requests: () => [...requests], subscriptions: () => subscribe.mock.calls.length };
};

const settle = async (ms = 20) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const switchTo = async (apiBaseUrl: string, runtimeKey: string) => {
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl, runtimeKey }));
  await settle();
};

const LOCAL_URL = 'http://127.0.0.1:4100';

class StaticMediaQuery extends EventTarget implements MediaQueryList {
  readonly matches = true;
  readonly media: string;
  onchange = null;

  constructor(media: string) {
    super();
    this.media = media;
  }

  addListener() {}

  removeListener() {}
}

describe('with several hosts a switch moves the focus', () => {
  let dom: ReturnType<typeof installHookTestDom>;
  let root: Root;
  let uninstall: () => void = () => {};
  let windowHost: HostRuntime;
  let respondToWindow: Respond = notFound;
  const windowRequests: string[] = [];
  const storage = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const registered: FakeHost[] = [];

  const track = (fake: FakeHost): FakeHost => {
    registered.push(fake);
    return fake;
  };

  beforeEach(() => {
    windowRequests.length = 0;
    respondToWindow = notFound;
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      const path = pathOf(input);
      windowRequests.push(path);
      return respondToWindow(path);
    }, { preconnect: async () => {} });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    });
    dom = installHookTestDom();
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://app.test/') });
    setMultiHostRuntime(false);
    switchRuntimeEndpoint({ apiBaseUrl: LOCAL_URL, runtimeKey: 'local' });
    windowHost = hostRegistry.focused();
    useConfigStore.forHost(windowHost.id).setState({ settingsMessageStreamTransport: 'sse' });
    setMultiHostRuntime(true);
    uninstall = installRuntimeEndpointReset();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    uninstall();
    hostsMonitoring.stop();
    hostRegistry.focus(windowHost.id);
    for (const fake of registered.splice(0)) hostRegistry.unregister(fake.host.id);
    setMultiHostRuntime(false);
    mock.restore();
    dom.restore();
    globalThis.fetch = originalFetch;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('a switch to a host that is already loaded makes no bootstrap request and keeps its engine', async () => {
    const pi = track(registerFakeHost('pi', (path) => (path === '/api/session-folders' ? Response.json({ version: 1, exists: false }) : notFound(path))));
    await act(async () => root.render(React.createElement(SyncProvider, { sdk: windowHost.client.getSdkClient(), directory: '/work', children: null })));
    await settle();
    expect(pi.subscriptions()).toBe(1);

    await switchTo('https://pi.example', 'host:pi');
    expect(hostRegistry.focused().id).toBe('host:pi');
    await switchTo(LOCAL_URL, 'local');
    expect(hostRegistry.focused().id).toBe('local');

    const sdk = pi.host.client.getSdkClient();
    const windowSdk = windowHost.client.getSdkClient();
    const before = pi.requests().length;
    await switchTo('https://pi.example', 'host:pi');
    await settle(300);

    expect(pi.requests().slice(before)).toEqual(['/api/config/settings']);
    expect(pi.subscriptions()).toBe(1);
    expect(pi.host.client.getSdkClient()).toBe(sdk);
    expect(windowHost.client.getSdkClient()).toBe(windowSdk);
    expect(hostRegistry.get('host:pi')).toBe(pi.host);
  });

  test('A to B and back keeps the selected session and an unsent draft', async () => {
    track(registerFakeHost('pi'));
    const identity: ChatDraftIdentity = { runtimeKey: 'local', directory: '/work', sessionId: 'ses_local' };
    let typed: (text: string) => void = () => {};
    let shown = '';
    const Composer = () => {
      const [message, setMessage] = React.useState('');
      const messageRef = React.useRef(message);
      const confirmedMentionsRef = React.useRef(new Set<string>());
      messageRef.current = message;
      useComposerDraft({ message, messageRef, setMessage, confirmedMentionsRef, identity, persistEnabled: false, initialDraft: { text: '', identity } });
      typed = setMessage;
      shown = message;
      return null;
    };
    useSessionUIStore.setState({ currentSessionId: 'ses_local', currentSessionDirectory: '/work' });
    await act(async () => root.render(React.createElement(Composer)));
    await act(async () => typed('half a thought'));
    await act(async () => root.render(null));

    await switchTo('https://pi.example', 'host:pi');
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    await switchTo(LOCAL_URL, 'local');

    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_local');
    await act(async () => root.render(React.createElement(Composer)));
    expect(shown).toBe('half a thought');
  });

  test('a host that needs a sign-in shows its gate in place of its own chat only', async () => {
    const pi = track(registerFakeHost('pi'));
    const pc = track(registerFakeHost('pc'));
    pi.host.status.setState({ connection: { state: 'auth-required' } });
    pc.host.status.setState({ connection: { state: 'live', since: 1, via: 'stream' } });
    windowHost.status.setState({ connection: { state: 'auth-required' } });
    const mounted = new Set<string>();
    const Chat = ({ id }: { id: string }) => {
      React.useEffect(() => {
        mounted.add(id);
        return () => { mounted.delete(id); };
      }, [id]);
      return null;
    };
    const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (media: string) => new StaticMediaQuery(media) });
    const gated = (id: string) => React.createElement(FocusedHostGate, { key: id, hostId: id, children: React.createElement(Chat, { id }) });
    await act(async () => root.render(React.createElement(I18nProvider, { children: [gated(pi.host.id), gated(pc.host.id), gated(windowHost.id)] })));
    await settle();

    expect([...mounted].sort()).toEqual(['host:pc', 'local']);
    if (previousMatchMedia) Object.defineProperty(globalThis, 'matchMedia', previousMatchMedia);
    else Reflect.deleteProperty(globalThis, 'matchMedia');
  });

  test('the compatibility check runs once per host and opens setup only for the incompatible one', async () => {
    const pi = track(registerFakeHost('pi', (path) => (path.endsWith('/codecli/compatibility') ? compatibility('incompatible') : notFound(path))));
    respondToWindow = (path) => (path.endsWith('/codecli/compatibility') ? compatibility('compatible') : notFound(path));
    useUIStore.getState().setEngineSetupOpen(false);
    await act(async () => root.render(React.createElement(CodeCliCompatibilityGate)));
    await settle();
    expect(useUIStore.getState().isEngineSetupOpen).toBe(false);

    await switchTo('https://pi.example', 'host:pi');
    expect(useUIStore.getState().isEngineSetupOpen).toBe(true);
    useUIStore.getState().setEngineSetupOpen(false);
    await switchTo(LOCAL_URL, 'local');
    expect(useUIStore.getState().isEngineSetupOpen).toBe(false);
    await switchTo('https://pi.example', 'host:pi');
    expect(useUIStore.getState().isEngineSetupOpen).toBe(true);

    const checks = (paths: string[]) => paths.filter((path) => path.endsWith('/codecli/compatibility')).length;
    expect(checks(windowRequests)).toBe(1);
    expect(checks(pi.requests())).toBe(1);
  });

  test('the hosts list comes from the runtimes, with no summary requests', async () => {
    const pi = track(registerFakeHost('pi'));
    const hosts = [savedHostOf('local', 'local', LOCAL_URL), savedHostOf('pi', 'host:pi', 'https://pi.example')];
    hostsMonitoring.ensure({ listHosts: async () => ({ status: 'ok', hosts }), getCredential: async () => null });
    await settle();
    const summaryRequests = () => [...windowRequests, ...pi.requests()].filter((path) => path.includes('/sessions/summary'));
    expect(summaryRequests()).toEqual([]);

    installRuntimeHostsMonitoring();
    await settle(50);

    expect(summaryRequests()).toEqual([]);
    expect(useHostsStore.getState().hosts.map((host) => host.descriptor.id)).toEqual(['pi']);
    expect(useHostsStore.getState().activeHost?.id).toBe('local');
    expect(pi.requests()).toContain('/api/sessions/status');
  });

  test('a background host row lists the projects of that host once it answers', async () => {
    const pi = track(registerFakeHost('pi', (path) => {
      if (path === '/api/sessions/status') return Response.json({});
      if (path === '/api/config/settings') return Response.json({ projects: [{ id: 'ignored', path: '/srv/pi-app', label: 'Pi app' }] });
      return notFound(path);
    }));
    const hosts = [savedHostOf('local', 'local', LOCAL_URL), savedHostOf('pi', 'host:pi', 'https://pi.example')];
    hostsMonitoring.ensure({ listHosts: async () => ({ status: 'ok', hosts }), getCredential: async () => null });
    installRuntimeHostsMonitoring();
    await settle(100);

    const row = useHostsStore.getState().hosts.find((host) => host.descriptor.id === 'pi');
    expect(row?.connection.state).toBe('live');
    expect(row?.snapshot.projects?.map((project) => [project.label, project.path])).toEqual([['Pi app', '/srv/pi-app']]);
    expect(pi.requests().filter((path) => path === '/api/config/settings')).toHaveLength(1);
    expect(windowRequests).not.toContain('/api/config/settings');
  });
});

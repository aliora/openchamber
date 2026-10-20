import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { OpencodeService } from '@/lib/opencode/client';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint, type RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { adoptRelayTunnelForHost, focusRegisteredHost, hostRegistry, registerHostEndpoint } from './app-host';
import { setMultiHostRuntime } from './multi-host-flag';
import { createRuntimeTransport, windowRuntimeTransport } from './runtime-transport';
import type { HostRuntime } from './types';

const relay = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv-pi',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
};

const fakeTunnel = (): RelayTunnelClient & { closed: () => boolean } => {
  let closed = false;
  return {
    fetch: async () => new Response(null, { status: 404 }),
    openWebSocket: () => { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    retry: () => {},
    close: () => { closed = true; },
    closed: () => closed,
  };
};

const registerDirectHost = (name: string): HostRuntime => {
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: async () => new Response(null, { status: 404 }),
    createTunnel: () => { throw new Error('no tunnel was adopted'); },
  });
  transport.reconfigure({ apiBaseUrl: `https://${name}.example` });
  const runtimeKey = `host:${name}`;
  return hostRegistry.register({
    descriptor: { id: name, label: name, kind: 'direct', displayUrl: `https://${name}.example/`, runtimeKey, monitored: true },
    endpoint: { kind: 'direct', apiUrl: `https://${name}.example` },
  }, async () => null, { transport, client: new OpencodeService({ transport, runtimeKey: () => runtimeKey }) });
};

describe('focusing hosts of a multi-host window', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousFetch = globalThis.fetch;
  const events: RuntimeEndpointChangedDetail[] = [];
  let stopListening: () => void = () => {};
  let windowHost: HostRuntime;

  beforeAll(() => {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://app.test/') });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    setMultiHostRuntime(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://local.example', runtimeKey: 'local' });
    windowHost = hostRegistry.focused();
    stopListening = subscribeRuntimeEndpointChanged((detail) => { events.push(detail); });
  });

  afterEach(() => {
    events.length = 0;
    if (hostRegistry.get(windowHost.id)) hostRegistry.focus(windowHost.id);
    for (const host of hostRegistry.list()) {
      if (host.id !== windowHost.id) hostRegistry.unregister(host.id);
    }
  });

  afterAll(() => {
    stopListening();
    globalThis.fetch = previousFetch;
    for (const [name, descriptor] of [['window', previousWindow], ['location', previousLocation], ['localStorage', previousStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('focusing a registered host moves the window key without touching its transport', () => {
    const pi = registerDirectHost('pi');
    const epoch = pi.transport.epoch;

    expect(focusRegisteredHost('host:pi')).toBe(true);

    expect(hostRegistry.focused()).toBe(pi);
    expect(getRuntimeKey()).toBe('host:pi');
    expect(pi.transport.epoch).toBe(epoch);
    expect(events.map((event) => [event.previousRuntimeKey, event.runtimeKey])).toEqual([['local', 'host:pi']]);

    expect(focusRegisteredHost('local')).toBe(true);
    expect(hostRegistry.focused()).toBe(windowHost);
    expect(focusRegisteredHost('host:unknown')).toBe(false);
  });

  test('a LAN to relay swap of a background host reconfigures its transport and reconnects its client in place', () => {
    const pi = registerDirectHost('pi');
    const clientEpoch = pi.client.epoch;
    const tunnel = fakeTunnel();
    const windowTunnel = windowRuntimeTransport().relay.tunnel();

    adoptRelayTunnelForHost('host:pi', relay, tunnel);
    expect(registerHostEndpoint('host:pi', { apiBaseUrl: 'https://app.test', relay })).toBe(true);

    expect(hostRegistry.get('host:pi')).toBe(pi);
    expect(pi.transport.relay.tunnel()).toBe(tunnel);
    expect(pi.client.epoch).toBe(clientEpoch + 1);
    expect(windowRuntimeTransport().relay.tunnel()).toBe(windowTunnel);
    expect(hostRegistry.focused()).toBe(windowHost);
    expect(events).toEqual([]);

    expect(registerHostEndpoint('host:pi', { apiBaseUrl: 'https://app.test', relay })).toBe(true);
    expect(pi.client.epoch).toBe(clientEpoch + 1);
    expect(registerHostEndpoint('local', { apiBaseUrl: 'https://elsewhere.example' })).toBe(false);
  });

  test('a probe tunnel for a host that is not registered yet goes to that host, not the focused one', () => {
    const tunnel = fakeTunnel();
    const windowTunnel = windowRuntimeTransport().relay.tunnel();

    adoptRelayTunnelForHost('relay:srv-pi', relay, tunnel);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://app.test', runtimeKey: 'relay:srv-pi', relay });

    const pi = hostRegistry.focused();
    expect(pi.id).toBe('relay:srv-pi');
    expect(pi.transport.relay.tunnel()).toBe(tunnel);
    expect(tunnel.closed()).toBe(false);
    expect(windowRuntimeTransport().relay.tunnel()).toBe(windowTunnel);
  });

  test('unregistering the focused host focuses another one and the window key follows', () => {
    registerDirectHost('pi');
    focusRegisteredHost('host:pi');
    events.length = 0;

    hostRegistry.unregister('host:pi');

    expect(hostRegistry.focused()).toBe(windowHost);
    expect(getRuntimeKey()).toBe('local');
    expect(events.map((event) => [event.previousRuntimeKey, event.runtimeKey])).toEqual([['host:pi', 'local']]);
  });

  test('unregistering a background host leaves the focus and the window key alone', () => {
    registerDirectHost('pi');
    hostRegistry.unregister('host:pi');

    expect(hostRegistry.focused()).toBe(windowHost);
    expect(getRuntimeKey()).toBe('local');
    expect(events).toEqual([]);
  });
});

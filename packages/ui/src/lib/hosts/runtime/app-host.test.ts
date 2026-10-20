import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createStore } from 'zustand';

import { OpencodeService, opencodeClient } from '@/lib/opencode/client';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeKey, initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { runWithHost } from './ambient-host';
import { defineHostStore, hostRegistry, resolveHost } from './app-host';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport, currentRuntimeTransport, windowRuntimeTransport } from './runtime-transport';

describe('the app host registry before multi-host', () => {
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

  test('holds the active runtime on first use and takes over the endpoint initialized at boot', () => {
    const early = resolveHost();
    expect(early.id).toBe(getRuntimeKey());
    expect(hostRegistry.list()).toEqual([early]);

    initializeRuntimeEndpoint({ apiBaseUrl: 'https://boot.example', runtimeKey: 'host:boot' });
    const booted = hostRegistry.focused();
    expect(booted.id).toBe('host:boot');
    expect(booted.descriptor).toEqual({
      id: 'host:boot', label: 'host:boot', kind: 'direct', displayUrl: 'https://boot.example/', runtimeKey: 'host:boot', monitored: false,
    });
    expect(booted.client).toBeInstanceOf(OpencodeService);
    expect(booted.client).toBe(early.client);
    expect(booted.transport.urls).toBe(windowRuntimeTransport().urls);
    expect(early.disposed).toBe(true);
    expect(hostRegistry.list()).toEqual([booted]);
  });

  test('every endpoint switch rebuilds the single entry at once, the same key included', () => {
    const before = hostRegistry.focused();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://boot.example', runtimeKey: 'host:boot', clientToken: 'fresh' });
    expect(before.disposed).toBe(true);
    const sameKey = hostRegistry.focused();
    expect(sameKey).not.toBe(before);
    expect(sameKey.id).toBe('host:boot');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example', runtimeKey: 'host:other' });
    expect(sameKey.disposed).toBe(true);
    const other = hostRegistry.focused();
    expect(other.id).toBe('host:other');
    expect(hostRegistry.list()).toEqual([other]);
    expect(hostRegistry.get('host:boot')).toBeUndefined();
  });

  test('resolveHost prefers the ambient host over the active one', () => {
    const active = hostRegistry.focused();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://third.example', runtimeKey: 'host:third' });
    expect(runWithHost(active, () => resolveHost())).toBe(active);
    expect(resolveHost().id).toBe('host:third');
  });

  test('the client facade and the global transport reach the ambient host, else the focused one', () => {
    const focused = hostRegistry.focused();
    expect(opencodeClient.getSdkClient()).toBe(focused.client.getSdkClient());
    expect(currentRuntimeTransport()).toBe(focused.transport);

    const transport = createRuntimeTransport({
      bootInjection: false,
      fetch: async () => new Response(null, { status: 204 }),
      createTunnel: () => { throw new Error('no tunnels here'); },
    });
    const elsewhere = createHostRegistry(() => ({ transport, client: new OpencodeService({ transport, runtimeKey: () => 'host:elsewhere' }) }))
      .register({
        descriptor: { id: 'host:elsewhere', label: 'host:elsewhere', kind: 'direct', displayUrl: 'https://elsewhere.example', runtimeKey: 'host:elsewhere', monitored: false },
        endpoint: { kind: 'direct', apiUrl: 'https://elsewhere.example' },
      }, async () => null);
    runWithHost(elsewhere, () => {
      expect(opencodeClient.getSdkClient()).toBe(elsewhere.client.getSdkClient());
      expect(currentRuntimeTransport()).toBe(transport);
    });
  });

  test('a host store keeps one copy per runtime and its subscribers move to the new runtime on a switch', () => {
    const useDraft = defineHostStore<{ text: string }>('draft', () => createStore<{ text: string }>()(() => ({ text: '' })));
    const heard: Array<[string, string]> = [];
    const unsubscribe = useDraft.subscribe((state, previous) => { heard.push([state.text, previous.text]); });

    useDraft.setState({ text: 'on third' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://fourth.example', runtimeKey: 'host:fourth' });
    expect(useDraft.getState().text).toBe('');
    expect(heard).toEqual([['on third', ''], ['', 'on third']]);
    unsubscribe();
  });

  test('a switch replaces the window host and leaves the hosts registered beside it', () => {
    const transport = createRuntimeTransport({
      bootInjection: false,
      fetch: async () => new Response(null, { status: 204 }),
      createTunnel: () => { throw new Error('no tunnels here'); },
    });
    const previousWindowHost = hostRegistry.focused();
    const beside = hostRegistry.register({
      descriptor: { id: 'host:beside', label: 'host:beside', kind: 'direct', displayUrl: 'https://beside.example', runtimeKey: 'host:beside', monitored: false },
      endpoint: { kind: 'direct', apiUrl: 'https://beside.example' },
    }, async () => null, { transport, client: new OpencodeService({ transport, runtimeKey: () => 'host:beside' }) });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://fifth.example', runtimeKey: 'host:fifth' });

    expect(hostRegistry.get(previousWindowHost.id)).toBeUndefined();
    expect(hostRegistry.get('host:beside')).toBe(beside);
    expect(hostRegistry.focused().id).toBe('host:fifth');
    hostRegistry.unregister('host:beside');
  });

  test('rebuilding the entry never closes the window transport it serves', () => {
    const relay = {
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv-window',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    };
    let closed = false;
    const tunnel: RelayTunnelClient = {
      fetch: async () => new Response(null, { status: 404 }),
      openWebSocket: () => { throw new Error('unused'); },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => {},
      retry: () => {},
      close: () => { closed = true; },
    };
    try {
      windowRuntimeTransport().relay.adopt(relay, tunnel);
      switchRuntimeEndpoint({ apiBaseUrl: 'https://relay-host.example', runtimeKey: 'host:relay', relay });
      const viaRelay = hostRegistry.focused();
      switchRuntimeEndpoint({ apiBaseUrl: 'https://relay-host.example', runtimeKey: 'host:relay', relay });

      expect(viaRelay.disposed).toBe(true);
      expect(viaRelay.descriptor.kind).toBe('relay');
      expect(closed).toBe(false);
      expect(hostRegistry.focused().transport.relay.tunnel()).toBe(tunnel);
    } finally {
      windowRuntimeTransport().relay.deactivate();
    }
    expect(closed).toBe(true);
  });
});

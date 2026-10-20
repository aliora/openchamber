import { describe, expect, test } from 'bun:test';

import { opencodeClient } from '@/lib/opencode/client';
import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient, RelayTunnelStatus, RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeBearerTokenSync, getRuntimeUrlAuthTokenSync } from '@/lib/runtime-auth';
import { authSessionStoreOf } from '@/lib/runtime-auth-expiry';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import type { RuntimeTransport } from './types';

type SeenRequest = { url: string; method: string; authorization: string | null };

const requestOf = (input: string | URL | Request, init?: RequestInit): SeenRequest => {
  const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://relative.invalid'), init);
  return { url: input instanceof Request ? input.url : String(input), method: request.method, authorization: request.headers.get('Authorization') };
};

const urlTokenResponse = (token: string): Response => Response.json({ token, expiresAt: Date.now() + 60_000 });

const createFakeNetwork = (name: string, status = 200) => {
  const seen: SeenRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = requestOf(input, init);
    seen.push(request);
    if (request.url.endsWith('/auth/url-token')) return urlTokenResponse(`url-${name}`);
    if (status !== 200) return new Response(null, { status });
    return Response.json({ from: name });
  };
  return { fetch, seen };
};

const createFakeTunnel = (name: string) => {
  const seen: SeenRequest[] = [];
  const sockets: string[] = [];
  let closed = false;
  const status: RelayTunnelStatus = { state: 'connected' };
  const socket: RelayTunnelWebSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => {},
    close: () => {},
  };
  const client: RelayTunnelClient = {
    fetch: async (input, init) => {
      const request = requestOf(input, init);
      seen.push(request);
      if (request.url.endsWith('/auth/url-token')) return urlTokenResponse(`tunnel-${name}`);
      return Response.json({ from: `tunnel-${name}` });
    },
    openWebSocket: (path) => {
      sockets.push(path);
      return socket;
    },
    getStatus: () => status,
    subscribeStatus: () => () => {},
    retry: () => {},
    close: () => {
      closed = true;
    },
  };
  return { client, seen, sockets, isClosed: () => closed };
};

const relayDescriptor = (serverId: string): RelayRuntimeDescriptor => ({
  relayUrl: 'wss://relay.example/ws',
  serverId,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: `x-${serverId}`, y: `y-${serverId}` },
});

const createDirectTransport = (name: string, apiBaseUrl: string, status = 200) => {
  const network = createFakeNetwork(name, status);
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: network.fetch,
    createTunnel: () => {
      throw new Error('a direct transport opens no tunnel');
    },
  });
  transport.reconfigure({ apiBaseUrl, clientToken: `token-${name}` });
  return { transport, network };
};

const createRelayTransport = (name: string) => {
  const network = createFakeNetwork(name);
  const tunnel = createFakeTunnel(name);
  const transport = createRuntimeTransport({ bootInjection: false, fetch: network.fetch, createTunnel: () => tunnel.client });
  transport.reconfigure({ apiBaseUrl: `https://${name}.example`, clientToken: `token-${name}`, relay: relayDescriptor(name) });
  return { transport, network, tunnel };
};

const settle = (transport: RuntimeTransport): Promise<string> => transport.auth.refreshUrlToken();

describe('two runtime transports', () => {
  test('each sends its requests to its own address with its own token', async () => {
    const a = createDirectTransport('a', 'https://a.example');
    const b = createDirectTransport('b', 'https://b.example');
    await Promise.all([settle(a.transport), settle(b.transport)]);

    await a.transport.fetch('/api/session');
    await b.transport.fetch('/api/session');

    expect(a.network.seen.map((request) => [request.url, request.authorization])).toEqual([
      ['https://a.example/auth/url-token', 'Bearer token-a'],
      ['https://a.example/api/session', 'Bearer token-a'],
    ]);
    expect(b.network.seen.map((request) => [request.url, request.authorization])).toEqual([
      ['https://b.example/auth/url-token', 'Bearer token-b'],
      ['https://b.example/api/session', 'Bearer token-b'],
    ]);
  });

  test('concurrent identical reads are shared within a transport, never across transports', async () => {
    const a = createDirectTransport('a', 'https://same.example');
    const b = createDirectTransport('b', 'https://same.example');
    await Promise.all([settle(a.transport), settle(b.transport)]);

    const responses = await Promise.all([
      a.transport.fetch('/api/config'),
      a.transport.fetch('/api/config'),
      b.transport.fetch('/api/config'),
    ]);

    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ from: 'a' }, { from: 'a' }, { from: 'b' }]);
    expect(a.network.seen.filter((request) => request.url.endsWith('/api/config'))).toHaveLength(1);
    expect(b.network.seen.filter((request) => request.url.endsWith('/api/config'))).toHaveLength(1);
  });

  test('each puts its own URL token on its socket and asset addresses', async () => {
    const a = createDirectTransport('a', 'https://a.example');
    const b = createDirectTransport('b', 'https://b.example');
    await Promise.all([settle(a.transport), settle(b.transport)]);

    expect(a.transport.urls.websocket('/api/terminal/ws')).toBe('wss://a.example/api/terminal/ws?oc_url_token=url-a');
    expect(b.transport.urls.websocket('/api/terminal/ws')).toBe('wss://b.example/api/terminal/ws?oc_url_token=url-b');
    expect(a.transport.urls.authenticatedAsset('/api/fs/raw')).toBe('https://a.example/api/fs/raw?oc_url_token=url-a');

    b.transport.auth.clearUrlToken();
    expect(a.transport.auth.urlToken()).toBe('url-a');
  });

  test('each rides its own relay tunnel, and closing one leaves the other open', async () => {
    const a = createRelayTransport('a');
    const b = createRelayTransport('b');
    await Promise.all([settle(a.transport), settle(b.transport)]);

    await a.transport.fetch('/api/session');
    a.transport.openWebSocket('wss://a.example/api/terminal/ws?oc_url_token=tunnel-a');
    b.transport.openWebSocket('wss://b.example/api/terminal/ws?oc_url_token=tunnel-b');

    expect(a.tunnel.seen.map((request) => [request.url, request.authorization])).toEqual([
      ['/auth/url-token', 'Bearer token-a'],
      ['/api/session', 'Bearer token-a'],
    ]);
    expect(b.tunnel.seen.map((request) => request.url)).toEqual(['/auth/url-token']);
    expect(a.tunnel.sockets).toEqual(['/api/terminal/ws?oc_url_token=tunnel-a']);
    expect(b.tunnel.sockets).toEqual(['/api/terminal/ws?oc_url_token=tunnel-b']);
    expect(a.network.seen).toEqual([]);
    expect(b.network.seen).toEqual([]);

    a.transport.close();
    expect(a.tunnel.isClosed()).toBe(true);
    expect(b.tunnel.isClosed()).toBe(false);
    expect(b.transport.relay.tunnel()).toBe(b.tunnel.client);
  });

  test('a session expiry seen on one transport leaves the other signed in', async () => {
    const a = createDirectTransport('a', 'https://a.example', 401);
    const b = createDirectTransport('b', 'https://b.example');
    await Promise.all([settle(a.transport), settle(b.transport)]);

    await a.transport.fetch('/api/session');
    await b.transport.fetch('/api/session');
    for (let tick = 0; tick < 20 && authSessionStoreOf(a.transport).getState().state !== 'expired'; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(authSessionStoreOf(a.transport).getState().state).toBe('expired');
    expect(authSessionStoreOf(b.transport).getState().state).toBe('ok');
    expect(a.network.seen.map((request) => request.url)).toContain('https://a.example/auth/session');
    expect(b.network.seen.map((request) => request.url)).not.toContain('https://b.example/auth/session');
  });

  test('the global runtime functions reach the transport of the ambient host', async () => {
    const b = createRelayTransport('b');
    await settle(b.transport);
    const registry = createHostRegistry(() => ({ transport: b.transport, client: opencodeClient }));
    const host = registry.register({
      descriptor: { id: 'b', label: 'b', kind: 'relay', displayUrl: 'relay://b', runtimeKey: 'host:b', monitored: false },
      endpoint: { kind: 'relay', relay: relayDescriptor('b') },
    }, async () => null);

    const response = await host.run(() => runtimeFetch('/api/session'));

    expect(await response.json()).toEqual({ from: 'tunnel-b' });
    expect(host.run(() => getRuntimeUrlResolver())).toBe(b.transport.urls);
    expect(host.run(() => getRuntimeBearerTokenSync())).toBe('token-b');
    expect(host.run(() => getRuntimeUrlAuthTokenSync())).toBe('tunnel-b');
    expect(host.run(() => getActiveRelayTunnel())).toBe(b.tunnel.client);
    expect(getActiveRelayTunnel()).toBeNull();
  });
});

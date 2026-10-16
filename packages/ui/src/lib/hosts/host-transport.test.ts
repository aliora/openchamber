import { describe, expect, test } from 'bun:test';

import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';
import { createHostTransport, type HostTransportDependencies } from './host-transport';
import type { HostCredential, HostEndpoint, HostRelayEndpoint, SavedHost } from './types';

const TOKEN = 'oc_client_secret_token';
const relay: HostRelayEndpoint = { relayUrl: 'wss://relay.example/ws', serverId: 'srv_1', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } };

const savedHost = (endpoint: HostEndpoint): SavedHost => ({
  descriptor: { id: 'h1', label: 'Studio', kind: endpoint.kind, displayUrl: 'https://studio.example', runtimeKey: 'host:h1', monitored: true },
  endpoint,
});

type SeenRequest = { url: string; headers: Headers };

const createFakeTunnel = (initial: RelayTunnelStatus = { state: 'connected' }) => {
  let status = initial;
  const requests: SeenRequest[] = [];
  let failWith: Error | null = null;
  let closed = 0;
  let retries = 0;
  let recoverOnRetry = true;
  const client: RelayTunnelClient = {
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      if (failWith) throw failWith;
      return new Response('{}', { status: 200 });
    },
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => status,
    subscribeStatus: () => () => undefined,
    retry: () => {
      retries += 1;
      if (!recoverOnRetry) return;
      failWith = null;
      status = { state: 'connected' };
    },
    close: () => {
      closed += 1;
      status = { state: 'idle' };
    },
  };
  return {
    client,
    requests,
    closedCount: () => closed,
    retryCount: () => retries,
    stayParked() {
      recoverOnRetry = false;
    },
    fail(error: Error, next: RelayTunnelStatus) {
      failWith = error;
      status = next;
    },
  };
};

const setup = (endpoint: HostEndpoint, options: { directFails?: boolean; neverAnswers?: boolean } = {}) => {
  const direct: SeenRequest[] = [];
  const tunnel = createFakeTunnel();
  let tunnelsCreated = 0;
  let credential: HostCredential | null = { token: TOKEN, requestHeaders: { 'X-Team': 'blue', Authorization: 'Bearer smuggled' } };
  const dependencies: HostTransportDependencies = {
    fetch: (url, init) => {
      direct.push({ url, headers: new Headers(init.headers) });
      if (options.neverAnswers) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (options.directFails) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    createTunnel: () => {
      tunnelsCreated += 1;
      return tunnel.client;
    },
    directConnectTimeoutMs: 20,
  };
  const transport = createHostTransport(savedHost(endpoint), async () => credential, dependencies);
  return {
    transport,
    direct,
    tunnel,
    tunnelsCreated: () => tunnelsCreated,
    setCredential(next: HostCredential | null) {
      credential = next;
    },
  };
};

const get = (transport: ReturnType<typeof createHostTransport>, path = '/api/sessions/summary', signal = new AbortController().signal) => (
  transport.fetch(path, { accept: 'application/json', signal })
);

describe('host transport', () => {
  test('a direct host gets the token in the Authorization header only, read on every request', async () => {
    const { transport, direct, setCredential } = setup({ kind: 'direct', apiUrl: 'https://studio.example/openchamber/' });

    expect((await get(transport)).ok).toBe(true);
    setCredential({ token: 'oc_client_rotated', requestHeaders: {} });
    expect((await get(transport, '/api/sessions/summary/stream')).ok).toBe(true);

    expect(direct.map((request) => request.url)).toEqual([
      'https://studio.example/openchamber/api/sessions/summary',
      'https://studio.example/openchamber/api/sessions/summary/stream',
    ]);
    expect(direct[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(direct[0].headers.get('X-Team')).toBe('blue');
    expect(direct[0].headers.get('Accept')).toBe('application/json');
    expect(direct[1].headers.get('Authorization')).toBe('Bearer oc_client_rotated');
    for (const request of direct) {
      expect(request.url).not.toContain(TOKEN);
      expect(request.url).not.toContain('rotated');
    }
  });

  test('a host without a saved token sends no Authorization header', async () => {
    const { transport, direct, setCredential } = setup({ kind: 'local', apiUrl: 'http://127.0.0.1:4100' });
    setCredential(null);
    await get(transport);
    expect(direct[0].headers.has('Authorization')).toBe(false);
  });

  test('a relay host goes through its own tunnel, opened once, with the token in a header', async () => {
    const { transport, direct, tunnel, tunnelsCreated } = setup({ kind: 'relay', relay });

    await get(transport);
    await get(transport, '/api/sessions/summary/stream');

    expect(direct).toHaveLength(0);
    expect(tunnelsCreated()).toBe(1);
    expect(tunnel.requests.map((request) => request.url)).toEqual(['/api/sessions/summary', '/api/sessions/summary/stream']);
    expect(tunnel.requests[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(tunnel.requests.some((request) => request.url.includes(TOKEN))).toBe(false);
  });

  test('a host with both legs falls back to the relay and keeps using it', async () => {
    const { transport, direct, tunnel } = setup({ kind: 'multi', apiUrl: 'http://192.168.1.20:3000', relay }, { directFails: true });

    expect((await get(transport)).ok).toBe(true);
    expect((await get(transport)).ok).toBe(true);

    expect(direct).toHaveLength(1);
    expect(tunnel.requests).toHaveLength(2);
  });

  test('names the relay limit when the relay refused the tunnel', async () => {
    const { transport, tunnel } = setup({ kind: 'relay', relay });
    tunnel.stayParked();
    tunnel.fail(new Error('relay connection limit reached'), { state: 'error', terminal: true, closeCode: 4029 });
    expect(await get(transport)).toEqual({ ok: false, reason: 'relay-limit' });
    expect(tunnel.retryCount()).toBe(1);
  });

  test('a tunnel parked on a terminal refusal gets one fresh attempt per request', async () => {
    const { transport, tunnel } = setup({ kind: 'relay', relay });
    await get(transport);
    tunnel.fail(new Error('relay connection replaced by another client'), { state: 'error', terminal: true, closeCode: 4002 });
    expect((await get(transport)).ok).toBe(true);
    expect(tunnel.retryCount()).toBe(1);
  });

  test('a direct address that never answers counts as unreachable, and a caller abort as aborted', async () => {
    const silent = setup({ kind: 'direct', apiUrl: 'http://10.0.0.9:3000' }, { neverAnswers: true });
    expect(await get(silent.transport)).toEqual({ ok: false, reason: 'unreachable' });

    const controller = new AbortController();
    const pending = get(silent.transport, '/api/sessions/summary', controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
  });

  test('hands over a connected tunnel once and closes one that is not connected', async () => {
    const live = setup({ kind: 'relay', relay });
    expect(live.transport.releaseTunnel()).toBeNull();
    await get(live.transport);
    expect(live.transport.releaseTunnel()).toBe(live.tunnel.client);
    expect(live.transport.releaseTunnel()).toBeNull();
    live.transport.close();
    expect(live.tunnel.closedCount()).toBe(0);

    const parked = setup({ kind: 'relay', relay });
    await get(parked.transport);
    parked.tunnel.fail(new Error('down'), { state: 'reconnecting' });
    expect(parked.transport.releaseTunnel()).toBeNull();
    expect(parked.tunnel.closedCount()).toBe(1);
  });

  test('a closed transport sends nothing', async () => {
    const { transport, direct } = setup({ kind: 'direct', apiUrl: 'https://studio.example' });
    transport.close();
    expect(await get(transport)).toEqual({ ok: false, reason: 'aborted' });
    expect(direct).toHaveLength(0);
  });
});

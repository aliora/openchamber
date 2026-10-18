import { describe, expect, test } from 'bun:test';

import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';
import { createHostRequest, createHostTransport, type HostFetchOptions, type HostFetchResult, type HostTransportDependencies } from './host-transport';
import type { HostCredential, HostEndpoint, HostRelayEndpoint, SavedHost } from './types';

const TOKEN = 'oc_client_secret_token';
const relay: HostRelayEndpoint = { relayUrl: 'wss://relay.example/ws', serverId: 'srv_1', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } };

const savedHost = (endpoint: HostEndpoint): SavedHost => ({
  descriptor: { id: 'h1', label: 'Studio', kind: endpoint.kind, displayUrl: 'https://studio.example', runtimeKey: 'host:h1', monitored: true },
  endpoint,
});

type SeenRequest = { url: string; headers: Headers; method?: string; body?: BodyInit | null };

const createFakeTunnel = (initial: RelayTunnelStatus = { state: 'connected' }) => {
  let status = initial;
  const requests: SeenRequest[] = [];
  let failWith: Error | null = null;
  let closed = 0;
  let retries = 0;
  let recoverOnRetry = true;
  const client: RelayTunnelClient = {
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method, body: init?.body });
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
      direct.push({ url, headers: new Headers(init.headers), method: init.method, body: init.body });
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
  test('a write carries its method and JSON body on the direct and the relay leg', async () => {
    const put = (transport: ReturnType<typeof createHostTransport>) => transport.fetch('/api/config/settings?surface=web', {
      accept: 'application/json',
      signal: new AbortController().signal,
      method: 'PUT',
      body: '{"fontSize":18}',
    });
    const direct = setup({ kind: 'direct', apiUrl: 'https://studio.example' });
    const viaRelay = setup({ kind: 'relay', relay });

    expect((await put(direct.transport)).ok).toBe(true);
    expect((await put(viaRelay.transport)).ok).toBe(true);

    for (const request of [direct.direct[0], viaRelay.tunnel.requests[0]]) {
      expect(request.method).toBe('PUT');
      expect(request.body).toBe('{"fontSize":18}');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    }
    expect((await get(direct.transport)).ok).toBe(true);
    expect(direct.direct[1].method).toBe('GET');
    expect(direct.direct[1].headers.has('Content-Type')).toBe(false);
  });

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

describe('a host transport as a plain request function', () => {
  const recording = (result: HostFetchResult | 'hang') => {
    const seen: Array<{ path: string; options: HostFetchOptions }> = [];
    const transport = {
      fetch: (path: string, options: HostFetchOptions) => {
        seen.push({ path, options });
        if (result !== 'hang') return Promise.resolve(result);
        return new Promise<HostFetchResult>((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }), { once: true });
        });
      },
    };
    return { transport, seen };
  };

  test('passes the method and body through and hands back the response', async () => {
    const response = new Response('{"tasks":[]}', { status: 200 });
    const { transport, seen } = recording({ ok: true, response });
    const request = createHostRequest(transport, 'Studio is not reachable');

    expect(await request('/api/projects/p1/scheduled-tasks', { method: 'PUT', body: '{"task":{}}' })).toBe(response);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/api/projects/p1/scheduled-tasks');
    expect(seen[0].options.method).toBe('PUT');
    expect(seen[0].options.body).toBe('{"task":{}}');
    expect(seen[0].options.accept).toBe('application/json');
  });

  test('a host that does not answer rejects with the given message', async () => {
    const { transport } = recording({ ok: false, reason: 'unreachable' });
    const request = createHostRequest(transport, 'Studio is not reachable');
    await expect(request('/api/projects/p1/scheduled-tasks')).rejects.toThrow('Studio is not reachable');
  });

  test('a host that stays silent past the timeout is given up on', async () => {
    const { transport } = recording('hang');
    const request = createHostRequest(transport, 'Studio is not reachable', 5);
    await expect(request('/api/projects/p1/scheduled-tasks')).rejects.toThrow('Studio is not reachable');
  });
});

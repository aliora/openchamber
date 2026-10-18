import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { RelayTunnelStatus } from '@/lib/relay/tunnel-client';
import type { DesktopHostRelay } from './desktopHosts';

type TunnelStub = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  getStatus: () => RelayTunnelStatus;
  close: () => void;
};

let nextTunnel: (() => TunnelStub) | null = null;
const tunnelModule = await import('@/lib/relay/tunnel-client');
mock.module('@/lib/relay/tunnel-client', () => ({
  ...tunnelModule,
  createRelayTunnelClient: () => {
    if (!nextTunnel) throw new Error('no tunnel stub registered');
    return nextTunnel();
  },
}));

const { desktopHostProbe, desktopHostsGet, desktopHostsSet, importDesktopHostPairing, isSameHostUrl, probeRelayDesktopHost, redactSensitiveUrl, resolveDesktopHostUrl } = await import('./desktopHosts');
const { buildPairingConnectionPayload, encodePairingConnectionPayload } = await import('./connectionPayload');

const withDesktopBridge = async <T>(handler: (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_DESKTOP__: {
        invoke: handler,
      },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('resolveDesktopHostUrl', () => {
  test('keeps regular host URLs unchanged', () => {
    expect(resolveDesktopHostUrl('https://example.com/app?x=1')).toEqual({
      persistedUrl: 'https://example.com/app?x=1',
      redeemUrl: null,
      kind: 'normal-host',
    });
  });

  test('detects tunnel connect links and stores only origin', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect?t=secret-token')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('detects tunnel connect links with trailing slash', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect/?t=secret-token#section')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect/?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('redacts tunnel tokens from labels', () => {
    expect(redactSensitiveUrl('https://example.trycloudflare.com/connect?t=secret-token')).toBe(
      'https://example.trycloudflare.com/connect?t=%5BREDACTED%5D',
    );
  });
});

describe('importDesktopHostPairing', () => {
  test('rejects malformed pairing links before changing hosts', async () => {
    await expect(importDesktopHostPairing('not-a-connect-link', [])).rejects.toThrow('invalid-connect-link');
  });

  test('re-pairing a saved direct host updates it in place', async () => {
    // The shell stores the address as `URL` prints it, with a trailing slash;
    // the server's link carries it without one.
    const saved = { id: 'build-box', label: 'Build box', url: 'http://127.0.0.1:3512/', apiUrl: 'http://127.0.0.1:3512/', clientToken: 'revoked-token' };
    const other = { id: 'studio', label: 'Studio', url: 'http://127.0.0.1:3511/', apiUrl: 'http://127.0.0.1:3511/' };
    const link = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair_1',
      secret: 'one-time-secret',
      label: 'vm',
      candidates: [{ type: 'lan', url: 'http://127.0.0.1:3512' }],
    }));
    const redeemed: string[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      redeemed.push(String(input));
      return Response.json({ ok: true, clientToken: 'fresh-token' });
    });
    try {
      const result = await importDesktopHostPairing(link, [saved, other]);
      expect(redeemed).toEqual(['http://127.0.0.1:3512/api/client-auth/pairing/redeem']);
      expect(result.hostId).toBe('build-box');
      expect(result.hosts.map((host) => [host.id, host.clientToken ?? null])).toEqual([
        ['build-box', 'fresh-token'],
        ['studio', null],
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('isSameHostUrl', () => {
  test('matches an address with and without the trailing slash, and nothing else', () => {
    expect(isSameHostUrl('http://127.0.0.1:3512/', 'http://127.0.0.1:3512')).toBe(true);
    expect(isSameHostUrl('http://LOCALHOST:3512', 'http://localhost:3512/')).toBe(true);
    expect(isSameHostUrl('http://127.0.0.1:3512/', 'http://127.0.0.1:3511/')).toBe(false);
    expect(isSameHostUrl('https://example.com/a', 'https://example.com/b')).toBe(false);
    expect(isSameHostUrl('relay://server', 'relay://server')).toBe(false);
  });
});

describe('desktop host runtime headers', () => {
  test('parses persisted request headers from desktop config', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-1',
          label: 'Remote',
          url: 'https://remote.example',
          requestHeaders: {
            ' CF-Access-Client-Id ': ' client-id ',
            Authorization: 'Bearer should-not-be-read',
            'Bad:Name': 'bad',
          },
        }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.requestHeaders).toEqual({
        'CF-Access-Client-Id': 'client-id',
      });
    });
  });

  test('passes request headers through host save and probe IPC calls', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'desktop_host_probe') return { status: 'ok', latencyMs: 7 };
      return null;
    }, async () => {
      const requestHeaders = { 'CF-Access-Client-Id': 'client-id' };
      await desktopHostsSet({
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders }],
        defaultHostId: 'remote-1',
      });
      const probe = await desktopHostProbe('https://remote.example', { requestHeaders });
      expect(probe).toEqual({ status: 'ok', latencyMs: 7 });
    });

    expect(calls[0]).toEqual({
      cmd: 'desktop_hosts_set',
      args: {
        input: {
          hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders: { 'CF-Access-Client-Id': 'client-id' } }],
          defaultHostId: 'remote-1',
          initialHostChoiceCompleted: undefined,
        },
      },
    });
    expect(calls[1]).toEqual({
      cmd: 'desktop_host_probe',
      args: {
        url: 'https://remote.example',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      },
    });
  });
});

describe('desktop SSH forwarding metadata', () => {
  test('reads the active SSH forward without treating ordinary hosts as forwarded', async () => {
    await withDesktopBridge(async () => ({
      hosts: [
        { id: 'ssh-1', label: 'SSH', url: 'http://127.0.0.1:54000', sshForwarded: true },
        { id: 'local-2', label: 'Local server', url: 'http://127.0.0.1:54001' },
      ],
      defaultHostId: 'ssh-1',
    }), async () => {
      const { hosts } = await desktopHostsGet();
      expect(hosts[0]?.sshForwarded).toBe(true);
      expect(hosts[1]?.sshForwarded).toBeUndefined();
    });
  });
});

describe('probeRelayDesktopHost', () => {
  const relay: DesktopHostRelay = {
    relayUrl: 'wss://relay.example',
    serverId: 'server-a',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  };

  const withTimerWindow = async <T>(run: () => Promise<T>): Promise<T> => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) },
    });
    try {
      return await run();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  };

  const stubTunnel = (
    responses: Array<Response | Error>,
    status: RelayTunnelStatus = { state: 'reconnecting' },
  ) => {
    const calls: string[] = [];
    let closed = false;
    nextTunnel = () => ({
      fetch: async (path) => {
        calls.push(path);
        const next = responses.shift();
        if (!next) throw new Error('relay tunnel reset');
        if (next instanceof Error) throw next;
        return next;
      },
      getStatus: () => status,
      close: () => { closed = true; },
    });
    return { calls, isClosed: () => closed };
  };

  test('a cold first attempt is retried instead of reported unreachable', async () => {
    // The tunnel rejects waiters on its first failed connect and then
    // reconnects; the probe must span that, not read it as an unreachable host.
    const tunnel = stubTunnel([
      new Error('relay tunnel reset: connection failed'),
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 200 }),
    ]);

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'token' }));

    expect(result.status).toBe('ok');
    expect(tunnel.calls).toEqual(['/health', '/health', '/auth/session']);
    expect(tunnel.isClosed()).toBe(true);
  });

  test('a terminal tunnel state ends the probe without retrying', async () => {
    // Auth failed / duplicate client / limit reached will not resolve by waiting.
    const tunnel = stubTunnel(
      [new Error('relay connection replaced by another client')],
      { state: 'error', terminal: true, closeCode: 4002 },
    );

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'token' }));

    expect(result.status).toBe('unreachable');
    expect(tunnel.calls).toEqual(['/health']);
  });

  test('a relay refusal over its limits is reported as relay-limit', async () => {
    const tunnel = stubTunnel(
      [new Error('relay connection limit reached')],
      { state: 'error', lastError: 'relay connection limit reached', terminal: true, closeCode: 4029 },
    );

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'token' }));

    expect(result).toEqual({ status: 'relay-limit', latencyMs: 0 });
    expect(tunnel.calls).toEqual(['/health']);
    expect(tunnel.isClosed()).toBe(true);
  });

  test('a rejected client token is reported as auth, not unreachable', async () => {
    const tunnel = stubTunnel([
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 401 }),
    ]);

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'stale' }));

    expect(result.status).toBe('auth');
    expect(tunnel.calls).toEqual(['/health', '/auth/session']);
  });
});

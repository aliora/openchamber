import { describe, expect, test } from 'bun:test';

import type { HostsAPI } from '@/lib/api/types';
import type { HostFetchOptions, HostTransport } from '@/lib/hosts/host-transport';
import type { SavedHost } from '@/lib/hosts/types';

import { sendApnsTokenToSavedHosts } from './mobilePushHosts';

const savedHost = (id: string, runtimeKey: string): SavedHost => ({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `http://${id}.local/`, runtimeKey, monitored: true },
  endpoint: { kind: 'direct', apiUrl: `http://${id}.local` },
});

const hosts = [savedHost('mac', 'http://mac.local'), savedHost('pi', 'http://pi.local'), savedHost('away', 'http://away.local')];

type Sent = { hostId: string; path: string; method?: string; body?: string; closed: boolean };

const setup = (options: { listed?: HostsAPI['listHosts']; unreachable?: string[] } = {}) => {
  const sent: Sent[] = [];
  const api: HostsAPI = {
    listHosts: options.listed ?? (async () => ({ status: 'ok', hosts })),
    getCredential: async () => ({ token: 'oc_client_x', requestHeaders: {} }),
  };
  const createTransport = (host: SavedHost): HostTransport => {
    const record: Sent = { hostId: host.descriptor.id, path: '', closed: false };
    return {
      async fetch(path: string, { method, body }: HostFetchOptions) {
        Object.assign(record, { path, method, body });
        sent.push(record);
        if (options.unreachable?.includes(host.descriptor.id)) return { ok: false, reason: 'unreachable' };
        return { ok: true, response: new Response('{"ok":true}', { status: 200 }) };
      },
      releaseTunnel: () => null,
      close: () => {
        record.closed = true;
      },
    };
  };
  return { sent, dependencies: { hosts: api, activeRuntimeKey: () => 'http://mac.local', createTransport } };
};

const payload = { token: 'device-token', platform: 'ios', environment: 'sandbox' as const };

describe('push token on every saved server', () => {
  test('registers the token with each saved server except the active one', async () => {
    const { sent, dependencies } = setup();

    const registered = await sendApnsTokenToSavedHosts('POST', payload, dependencies);

    expect(registered).toEqual(['pi', 'away']);
    expect(sent.map(({ hostId, path, method }) => [hostId, path, method])).toEqual([
      ['pi', '/api/push/apns-token', 'POST'],
      ['away', '/api/push/apns-token', 'POST'],
    ]);
    expect(JSON.parse(sent[0].body ?? '')).toEqual(payload);
    expect(sent.every(({ closed }) => closed)).toBe(true);
  });

  test('removes the token from each saved server', async () => {
    const { sent, dependencies } = setup();

    await sendApnsTokenToSavedHosts('DELETE', { token: 'device-token' }, dependencies);

    expect(sent.map(({ method }) => method)).toEqual(['DELETE', 'DELETE']);
  });

  test('a server that does not answer leaves the others registered', async () => {
    const { dependencies } = setup({ unreachable: ['pi'] });

    expect(await sendApnsTokenToSavedHosts('POST', payload, dependencies)).toEqual(['away']);
  });

  test('does nothing when the saved servers cannot be read', async () => {
    const { sent, dependencies } = setup({ listed: async () => { throw new Error('keychain'); } });

    expect(await sendApnsTokenToSavedHosts('POST', payload, dependencies)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

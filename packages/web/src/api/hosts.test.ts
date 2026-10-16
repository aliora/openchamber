import { describe, expect, it } from 'vitest';

import type { DesktopHost } from '@openchamber/ui/lib/desktopHosts';
import { createWebHostsAPI, isLocalDesktopPage, type WebHostsDependencies } from './hosts';

const relay = { relayUrl: 'wss://relay.example/ws', serverId: 'srv_studio', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } };

const hosts: DesktopHost[] = [
  { id: 'laptop', label: 'Laptop', url: 'https://laptop.example', apiUrl: 'https://laptop.example/?token=leak', clientToken: 'oc_client_laptop', requestHeaders: { 'X-Team': 'blue' } },
  { id: 'studio', label: 'Studio', url: 'relay://srv_studio', clientToken: 'oc_client_studio', relay },
  { id: 'office', label: 'Office', url: 'http://192.168.1.20:3000', apiUrl: 'http://192.168.1.20:3000', clientToken: 'oc_client_office', relay },
  { id: 'broken', label: 'Broken', url: 'not a url' },
];

const desktop = (overrides: Partial<WebHostsDependencies> = {}) => {
  let reads = 0;
  const dependencies: WebHostsDependencies = {
    isSupported: () => true,
    readHosts: async () => {
      reads += 1;
      return { hosts, defaultHostId: null, initialHostChoiceCompleted: true, localOrigin: 'http://127.0.0.1:4100' };
    },
    readLocalToken: async () => 'oc_client_local',
    ...overrides,
  };
  return { api: createWebHostsAPI(dependencies), reads: () => reads };
};

describe('web hosts API', () => {
  it('lists Local and every reachable saved host, without credentials', async () => {
    const { api } = desktop();
    const result = await api.listHosts();
    if (result.status !== 'ok') throw new Error('expected hosts');

    expect(result.hosts.map(({ descriptor }) => [descriptor.id, descriptor.kind, descriptor.runtimeKey, descriptor.displayUrl])).toEqual([
      ['local', 'local', 'local', 'http://127.0.0.1:4100/'],
      ['laptop', 'direct', 'host:laptop', 'https://laptop.example/?token=%5BREDACTED%5D'],
      ['studio', 'relay', 'host:studio', 'relay://srv_studio'],
      ['office', 'multi', 'host:office', 'http://192.168.1.20:3000/'],
    ]);
    expect(result.hosts[3].endpoint).toEqual({ kind: 'multi', apiUrl: 'http://192.168.1.20:3000', relay });
    expect(result.hosts.every(({ descriptor }) => descriptor.monitored)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('oc_client');
  });

  it('reads each credential from the desktop shell when asked', async () => {
    const { api, reads } = desktop();
    expect(await api.getCredential('local')).toEqual({ token: 'oc_client_local', requestHeaders: {} });
    expect(await api.getCredential('laptop')).toEqual({ token: 'oc_client_laptop', requestHeaders: { 'X-Team': 'blue' } });
    expect(await api.getCredential('studio')).toEqual({ token: 'oc_client_studio', requestHeaders: {} });
    expect(await api.getCredential('missing')).toBeNull();
    expect(reads()).toBe(3);
  });

  it('a failed read of the saved hosts is a failure, not an empty list', async () => {
    const { api } = desktop({ readHosts: async () => { throw new Error('ipc closed'); } });
    await expect(api.listHosts()).rejects.toThrow('ipc closed');
  });

  it('answers unsupported outside the desktop app\'s own pages', async () => {
    const { api } = desktop({ isSupported: () => false });
    expect(await api.listHosts()).toEqual({ status: 'unsupported' });
    expect(await api.getCredential('laptop')).toBeNull();
    // Plain web, hosted mobile and the phone app: not the Electron shell.
    expect(await createWebHostsAPI().listHosts()).toEqual({ status: 'unsupported' });
  });

  it('treats only the packaged UI, the local server and the dev server as the app\'s own page', () => {
    expect(isLocalDesktopPage('openchamber-ui://app', 'http://127.0.0.1:4100', false)).toBe(true);
    expect(isLocalDesktopPage('http://127.0.0.1:4100', 'http://127.0.0.1:4100/', false)).toBe(true);
    expect(isLocalDesktopPage('https://studio.example', 'http://127.0.0.1:4100', false)).toBe(false);
    expect(isLocalDesktopPage('https://studio.example', undefined, false)).toBe(false);
    expect(isLocalDesktopPage('null', 'http://127.0.0.1:4100', false)).toBe(false);
    expect(isLocalDesktopPage('http://127.0.0.1:5173', 'http://127.0.0.1:3901', true)).toBe(true);
  });
});

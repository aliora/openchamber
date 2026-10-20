import { describe, expect, test } from 'bun:test';

import type { DesktopHost } from '@/lib/desktopHosts';
import { createDesktopHostConnector } from './connect-desktop-host';
import type { HostRuntime, RuntimeTransportEndpoint } from './types';

const relay = { relayUrl: 'wss://relay.example/ws', serverId: 'srv-office', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };

const runtimeOf = (id: string): Pick<HostRuntime, 'id'> => ({ id });

type Fixture = {
  hosts: DesktopHost[];
  sshIds?: string[];
  sshReady?: boolean;
  direct?: boolean;
  forwardAfterConnect?: string;
};

const connectorFor = (fixture: Fixture) => {
  const applied: Array<[string, RuntimeTransportEndpoint]> = [];
  const calls: string[] = [];
  const hosts = [...fixture.hosts];
  const connect = createDesktopHostConnector({
    isSshHost: async (hostId) => (fixture.sshIds ?? []).includes(hostId),
    sshReady: async () => fixture.sshReady === true,
    connectSsh: async (hostId) => {
      calls.push(`ssh:${hostId}`);
      const index = hosts.findIndex((host) => host.id === hostId);
      if (index >= 0 && fixture.forwardAfterConnect) hosts[index] = { ...hosts[index], apiUrl: fixture.forwardAfterConnect };
    },
    readHost: async (hostId) => hosts.find((host) => host.id === hostId) ?? null,
    answersDirect: async (url) => {
      calls.push(`probe:${url}`);
      return fixture.direct === true;
    },
    relayApiBaseUrl: () => 'openchamber-ui://app',
    apply: (id, endpoint) => { applied.push([id, endpoint]); },
  });
  return { connect, applied, calls };
};

describe('connecting a desktop host before its transport is used', () => {
  test('Local, a plain direct host and keys that are not saved hosts are left as they are', async () => {
    const { connect, applied, calls } = connectorFor({ hosts: [{ id: 'pi', label: 'Pi', url: 'http://pi:3000', apiUrl: 'http://pi:3000' }] });
    await connect(runtimeOf('local'));
    await connect(runtimeOf('host:pi'));
    await connect(runtimeOf('relay:srv@wss://relay.example'));
    expect(applied).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a host with both legs is reached direct when its address answers', async () => {
    const { connect, applied } = connectorFor({
      direct: true,
      hosts: [{ id: 'office', label: 'Office', url: 'http://192.168.1.20:3000', apiUrl: 'http://192.168.1.20:3000', clientToken: 'oc_client_office', relay }],
    });
    await connect(runtimeOf('host:office'));
    expect(applied).toEqual([['host:office', { apiBaseUrl: 'http://192.168.1.20:3000', clientToken: 'oc_client_office', requestHeaders: null }]]);
  });

  test('a host whose address does not answer falls back to its relay', async () => {
    const { connect, applied, calls } = connectorFor({
      direct: false,
      hosts: [{ id: 'office', label: 'Office', url: 'http://192.168.1.20:3000', apiUrl: 'http://192.168.1.20:3000', clientToken: 'oc_client_office', relay }],
    });
    await connect(runtimeOf('host:office'));
    expect(calls).toEqual(['probe:http://192.168.1.20:3000']);
    expect(applied).toEqual([['host:office', { apiBaseUrl: 'openchamber-ui://app', clientToken: 'oc_client_office', requestHeaders: null, relay }]]);
  });

  test('a relay-only host goes straight to the relay', async () => {
    const { connect, applied, calls } = connectorFor({ hosts: [{ id: 'studio', label: 'Studio', url: 'relay://srv-office', relay }] });
    await connect(runtimeOf('host:studio'));
    expect(calls).toEqual([]);
    expect(applied.map(([, endpoint]) => endpoint.relay)).toEqual([relay]);
  });

  test('an SSH host opens its tunnel first and is then reached at its forward', async () => {
    const { connect, applied, calls } = connectorFor({
      sshIds: ['castle'],
      forwardAfterConnect: 'http://127.0.0.1:62545',
      hosts: [{ id: 'castle', label: 'Castle', url: 'http://127.0.0.1:1', apiUrl: 'http://127.0.0.1:1', clientToken: 'oc_client_castle' }],
    });
    await connect(runtimeOf('host:castle'));
    expect(calls).toEqual(['ssh:castle']);
    expect(applied).toEqual([['host:castle', { apiBaseUrl: 'http://127.0.0.1:62545', clientToken: 'oc_client_castle', requestHeaders: null }]]);
  });

  test('an SSH host whose tunnel already runs is not connected again', async () => {
    const { connect, calls, applied } = connectorFor({
      sshIds: ['castle'],
      sshReady: true,
      hosts: [{ id: 'castle', label: 'Castle', url: 'http://127.0.0.1:62545', apiUrl: 'http://127.0.0.1:62545' }],
    });
    await connect(runtimeOf('host:castle'));
    expect(calls).toEqual([]);
    expect(applied.map(([id]) => id)).toEqual(['host:castle']);
  });
});

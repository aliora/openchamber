import type { ApnsTokenPayload, HostsAPI } from '@/lib/api/types';
import { createHostTransport, type HostTransport } from '@/lib/hosts/host-transport';
import type { SavedHost } from '@/lib/hosts/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { mobileHostsAPI } from './mobileHosts';

export type MobilePushHostsDependencies = {
  hosts: HostsAPI;
  activeRuntimeKey: () => string;
  createTransport: (host: SavedHost, hosts: HostsAPI) => HostTransport;
};

const APNS_TOKEN_PATH = '/api/push/apns-token';
const REQUEST_TIMEOUT_MS = 15_000;

const defaultDependencies: MobilePushHostsDependencies = {
  hosts: mobileHostsAPI,
  activeRuntimeKey: getRuntimeKey,
  createTransport: (host, hosts) => createHostTransport(host, () => hosts.getCredential(host.descriptor.id)),
};

const sendToHost = async (transport: HostTransport, method: 'POST' | 'DELETE', body: string): Promise<boolean> => {
  try {
    const result = await transport.fetch(APNS_TOKEN_PATH, {
      accept: 'application/json',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method,
      body,
    });
    return result.ok && result.response.ok;
  } finally {
    transport.close();
  }
};

/**
 * Sends this phone's push token to every saved server but the active one (that
 * one gets it through the runtime's own push API), so a server the phone is
 * not looking at can still reach it. Resolves with the ids of the servers that
 * accepted it.
 */
export const sendApnsTokenToSavedHosts = async (
  method: 'POST' | 'DELETE',
  payload: ApnsTokenPayload,
  dependencies: MobilePushHostsDependencies = defaultDependencies,
): Promise<string[]> => {
  const listed = await dependencies.hosts.listHosts().catch(() => null);
  if (listed?.status !== 'ok') return [];
  const activeKey = dependencies.activeRuntimeKey();
  const accepted = await Promise.all(
    listed.hosts
      .filter((host) => host.descriptor.runtimeKey !== activeKey)
      .map(async (host) => {
        const body = JSON.stringify({ ...payload, clientConnectionId: host.descriptor.id });
        return (await sendToHost(dependencies.createTransport(host, dependencies.hosts), method, body)) ? host.descriptor.id : null;
      }),
  );
  return accepted.filter((id): id is string => id !== null);
};

export const activeSavedHostId = async (
  dependencies: MobilePushHostsDependencies = defaultDependencies,
): Promise<string | undefined> => {
  const listed = await dependencies.hosts.listHosts().catch(() => null);
  if (listed?.status !== 'ok') return undefined;
  const activeKey = dependencies.activeRuntimeKey();
  return listed.hosts.find((host) => host.descriptor.runtimeKey === activeKey)?.descriptor.id;
};

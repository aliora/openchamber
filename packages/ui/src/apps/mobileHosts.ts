import type { HostsAPI } from '@/lib/api/types';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import type { HostEndpoint, SavedHost } from '@/lib/hosts/types';

import {
  connectionDisplayUrl,
  directCandidates,
  loadMobileConnections,
  readSavedConnectionToken,
  relayCandidateOf,
  secureTokenKeyOf,
  type MobileSavedConnection,
} from './mobileConnections';

export type MobileHostsDependencies = {
  readConnections(): Promise<MobileSavedConnection[]>;
  readToken(connection: MobileSavedConnection): Promise<{ token?: string } | null>;
};

const toEndpoint = (connection: MobileSavedConnection): HostEndpoint | null => {
  const apiUrl = directCandidates(connection)[0]?.url;
  const relay = relayCandidateOf(connection);
  if (apiUrl && relay) return { kind: 'multi', apiUrl, relay };
  if (relay) return { kind: 'relay', relay };
  return apiUrl ? { kind: 'direct', apiUrl } : null;
};

const toSavedHost = (connection: MobileSavedConnection): SavedHost[] => {
  const endpoint = toEndpoint(connection);
  if (!endpoint) return [];
  return [{
    descriptor: {
      id: connection.id,
      label: connection.label,
      kind: endpoint.kind,
      displayUrl: redactSensitiveUrl(connectionDisplayUrl(connection)),
      runtimeKey: secureTokenKeyOf(connection),
      monitored: true,
    },
    endpoint,
  }];
};

export const createMobileHostsAPI = (dependencies: MobileHostsDependencies): HostsAPI => ({
  async listHosts() {
    return { status: 'ok', hosts: (await dependencies.readConnections()).flatMap(toSavedHost) };
  },

  async getCredential(hostId) {
    const connection = (await dependencies.readConnections()).find((entry) => entry.id === hostId);
    if (!connection) return null;
    const saved = await dependencies.readToken(connection);
    return { token: saved?.token ?? null, requestHeaders: {} };
  },
});

export const mobileHostsAPI = createMobileHostsAPI({
  readConnections: loadMobileConnections,
  readToken: readSavedConnectionToken,
});

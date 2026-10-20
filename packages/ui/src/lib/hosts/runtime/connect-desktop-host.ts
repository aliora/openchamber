import { LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import {
  desktopHostProbe,
  desktopHostsGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  type DesktopHost,
} from '@/lib/desktopHosts';
import { desktopSshConnect, desktopSshInstancesGet, desktopSshStatus } from '@/lib/desktopSsh';
import { applyHostEndpoint } from './app-host';
import { desktopHostIdOf } from './desktop-host-focus';
import type { HostRuntime, RuntimeTransportEndpoint } from './types';

const SSH_CONNECT_TIMEOUT_MS = 90_000;
const SSH_STATUS_POLL_MS = 700;

const sleep = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

const waitForSshReady = async (id: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await desktopSshStatus(id).catch(() => []);
    const status = statuses.find((item) => item.id === id);
    if (status?.phase === 'ready') return;
    if (status?.phase === 'error') throw new Error(status.detail || 'SSH connection failed');
    await sleep(SSH_STATUS_POLL_MS);
  }
  throw new Error('Timed out waiting for SSH connection');
};

const connectSshHost = async (id: string): Promise<void> => {
  await desktopSshConnect(id);
  await waitForSshReady(id, SSH_CONNECT_TIMEOUT_MS);
};

type DesktopHostConnectorDependencies = {
  isSshHost(hostId: string): Promise<boolean>;
  sshReady(hostId: string): Promise<boolean>;
  connectSsh(hostId: string): Promise<void>;
  readHost(hostId: string): Promise<DesktopHost | null>;
  answersDirect(url: string, host: DesktopHost): Promise<boolean>;
  relayApiBaseUrl(): string;
  apply(runtimeId: string, endpoint: RuntimeTransportEndpoint): void;
};

const credentialOf = (host: DesktopHost) => ({
  clientToken: host.clientToken || null,
  requestHeaders: host.requestHeaders || null,
});

export const createDesktopHostConnector = (dependencies: DesktopHostConnectorDependencies) => async (runtime: Pick<HostRuntime, 'id'>): Promise<void> => {
  const hostId = desktopHostIdOf(runtime.id);
  if (!hostId || hostId === LOCAL_HOST_ID) return;
  if (await dependencies.isSshHost(hostId)) {
    if (!(await dependencies.sshReady(hostId))) await dependencies.connectSsh(hostId);
    const host = await dependencies.readHost(hostId);
    const apiBaseUrl = host ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
    if (host && apiBaseUrl) dependencies.apply(runtime.id, { apiBaseUrl, ...credentialOf(host) });
    return;
  }
  const host = await dependencies.readHost(hostId);
  if (!host?.relay) return;
  const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
  if (directUrl && await dependencies.answersDirect(directUrl, host)) {
    dependencies.apply(runtime.id, { apiBaseUrl: directUrl, ...credentialOf(host) });
    return;
  }
  dependencies.apply(runtime.id, { apiBaseUrl: dependencies.relayApiBaseUrl(), ...credentialOf(host), relay: host.relay });
};

const BLOCKED_PROBE_STATUSES = new Set(['unreachable', 'wrong-service', 'incompatible']);

export const connectDesktopHost = createDesktopHostConnector({
  isSshHost: async (hostId) => (await desktopSshInstancesGet().catch(() => ({ instances: [] }))).instances.some((instance) => instance.id === hostId),
  sshReady: async (hostId) => (await desktopSshStatus(hostId).catch(() => [])).some((status) => status.id === hostId && status.phase === 'ready'),
  connectSsh: async (hostId) => {
    await connectSshHost(hostId).catch(() => null);
  },
  readHost: async (hostId) => (await desktopHostsGet().catch(() => null))?.hosts.find((host) => host.id === hostId) ?? null,
  answersDirect: async (url, host) => {
    const probe = await desktopHostProbe(url, { ...credentialOf(host), expectedServerId: host.relay?.serverId ?? null })
      .catch(() => ({ status: 'unreachable' as const }));
    return !BLOCKED_PROBE_STATUSES.has(probe.status);
  },
  relayApiBaseUrl: () => globalThis.location?.origin ?? '',
  apply: applyHostEndpoint,
});

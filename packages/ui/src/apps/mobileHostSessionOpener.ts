import { useHostsStore } from '@/lib/hosts/hosts-store';
import {
  createHostSessionOpener,
  hostSessionOpenerDependencies,
  type HostSessionOpener,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';
import type { MonitoredHost } from '@/lib/hosts/types';

import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';

import { connectSavedMobileConnection, type AutoConnectOutcome } from './mobileConnections';

const SESSIONS_TIMEOUT_MS = 10_000;

export const connectMobileHost = async (
  connectionId: string,
  connect: (id: string) => Promise<AutoConnectOutcome> = connectSavedMobileConnection,
): Promise<void> => {
  const outcome = await connect(connectionId);
  if (outcome.status !== 'connected') throw new Error(outcome.status);
};

export const withMobileConnect = (
  dependencies: HostSessionOpenerDependencies,
  connect: (connectionId: string) => Promise<void>,
  loadSessions: () => Promise<unknown>,
): HostSessionOpenerDependencies => ({
  ...dependencies,
  switchToHost: async (host) => {
    await connect(host.id);
    void loadSessions().catch(() => undefined);
  },
  openInHostWindow: () => false,
});

const scheduleSessionsTimeout = (onTimeout: () => void): (() => void) => {
  const timeoutId = window.setTimeout(onTimeout, SESSIONS_TIMEOUT_MS);
  return () => window.clearTimeout(timeoutId);
};

export const mobileHostSessionOpener = createHostSessionOpener({
  ...withMobileConnect(
    hostSessionOpenerDependencies,
    (connectionId) => connectMobileHost(connectionId),
    () => refreshGlobalSessions(),
  ),
  scheduleSessionsTimeout,
});

export const openSessionOnSavedConnection = (
  connectionId: string,
  sessionId: string,
  hosts: readonly MonitoredHost[] = useHostsStore.getState().hosts,
  opener: HostSessionOpener = mobileHostSessionOpener,
): boolean => {
  const host = hosts.find((entry) => entry.descriptor.id === connectionId);
  if (!host) return false;
  void opener.open({
    host: host.descriptor,
    connection: host.connection,
    target: { kind: 'session', sessionId, directory: host.snapshot.sessions.get(sessionId)?.directory ?? '' },
    confirmLeavingDraft: async () => true,
    onProblem: () => undefined,
  });
  return true;
};

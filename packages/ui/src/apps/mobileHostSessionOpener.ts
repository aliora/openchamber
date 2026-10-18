import {
  createHostSessionOpener,
  hostSessionOpenerDependencies,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';

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

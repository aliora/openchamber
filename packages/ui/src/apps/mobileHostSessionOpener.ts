import {
  createHostSessionOpener,
  hostSessionOpenerDependencies,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';

import { connectSavedMobileConnection, type AutoConnectOutcome } from './mobileConnections';

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
): HostSessionOpenerDependencies => ({
  ...dependencies,
  switchToHost: (host) => connect(host.id),
  openInHostWindow: () => false,
});

export const mobileHostSessionOpener = createHostSessionOpener(
  withMobileConnect(hostSessionOpenerDependencies, (connectionId) => connectMobileHost(connectionId)),
);

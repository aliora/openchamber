import { useHostsStore } from '@/lib/hosts/hosts-store';
import {
  createHostSessionOpener,
  hostSessionOpenerDependencies,
  type HostSessionOpener,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';
import { focusRegisteredHost } from '@/lib/hosts/runtime/app-host';
import type { MonitoredHost } from '@/lib/hosts/types';

import { connectSavedMobileConnection, type AutoConnectOutcome } from './mobileConnections';

export const connectMobileHost = async (
  connectionId: string,
  connect: (id: string) => Promise<AutoConnectOutcome> = connectSavedMobileConnection,
): Promise<void> => {
  const outcome = await connect(connectionId);
  if (outcome.status !== 'connected') throw new Error(outcome.status);
};

export const withMobileFocus = (
  dependencies: HostSessionOpenerDependencies,
  focusRegistered: (runtimeKey: string) => boolean,
  connect: (connectionId: string) => Promise<void>,
): HostSessionOpenerDependencies => ({
  ...dependencies,
  focusHost: async (host) => {
    if (focusRegistered(host.runtimeKey)) return;
    await connect(host.id);
  },
  openInHostWindow: () => false,
});

const afterNextPaint = (): Promise<void> => new Promise((resolve) => {
  window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
});

export const mobileHostSessionOpener = createHostSessionOpener(withMobileFocus(
  hostSessionOpenerDependencies,
  focusRegisteredHost,
  async (connectionId) => {
    await afterNextPaint();
    await connectMobileHost(connectionId);
  },
));

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
    target: { kind: 'session', sessionId, directory: host.snapshot.sessions.get(sessionId)?.directory ?? '' },
    onProblem: () => undefined,
  });
  return true;
};

import type { HostsAPI } from '@/lib/api/types';
import { registerProfileFanOutTargets } from '@/lib/settings/profile-fan-out';
import type { HostTransport } from './host-transport';
import { useHostsStore } from './hosts-store';
import { isMultiHostRuntimeEnabled } from './runtime/multi-host-flag';

export type HostsMonitoring = {
  /** Starts monitoring with the runtime's hosts API. Idempotent for the same API; null reads as unsupported. */
  ensure(api: HostsAPI | null): void;
  /** Re-reads the saved hosts and makes every monitor try again now. */
  refresh(): void;
  watchedTransports(): readonly HostTransport[];
  /** The transport of one watched host; null for the active host or one not watched. */
  transportFor(hostId: string): HostTransport | null;
  stop(): void;
};

let runtimeMonitoring: HostsMonitoring | null = null;
let requestedApi: { api: HostsAPI | null } | null = null;

export const provideRuntimeHostsMonitoring = (monitoring: HostsMonitoring): void => {
  runtimeMonitoring = monitoring;
  if (requestedApi) monitoring.ensure(requestedApi.api);
};

export const hostsMonitoring: HostsMonitoring = {
  ensure: (api) => {
    requestedApi = { api };
    if (!isMultiHostRuntimeEnabled()) {
      useHostsStore.getState().setAvailability('unsupported');
      return;
    }
    runtimeMonitoring?.ensure(api);
  },
  refresh: () => runtimeMonitoring?.refresh(),
  watchedTransports: () => runtimeMonitoring?.watchedTransports() ?? [],
  transportFor: (hostId) => runtimeMonitoring?.transportFor(hostId) ?? null,
  stop: () => {
    requestedApi = null;
    runtimeMonitoring?.stop();
  },
};

registerProfileFanOutTargets(() => hostsMonitoring.watchedTransports());

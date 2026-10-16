import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { hostsMonitoring } from './hosts-monitoring';
import { useHostsStore } from './hosts-store';
import type { HostsAvailability, MonitoredHost } from './types';

type MonitoredHostsView = {
  availability: HostsAvailability;
  /** Every saved host except the active one, in the order the runtime lists them. */
  hosts: readonly MonitoredHost[];
};

/**
 * The hosts this window watches besides the active one, with each host's
 * connection and session list. The first caller starts monitoring; it then
 * runs for the life of the page. An entry object changes only when that host
 * changes, and an unchanged session row keeps its object.
 */
export const useMonitoredHosts = (): MonitoredHostsView => {
  const apis = useRuntimeAPIs();
  const hostsApi = apis.hosts ?? null;
  React.useEffect(() => {
    hostsMonitoring.ensure(hostsApi);
  }, [hostsApi]);
  const availability = useHostsStore((state) => state.availability);
  const hosts = useHostsStore((state) => state.hosts);
  return React.useMemo(() => ({ availability, hosts }), [availability, hosts]);
};

/** Re-reads the saved hosts and retries every host now, for a Refresh action. */
export const refreshMonitoredHosts = (): void => {
  hostsMonitoring.refresh();
};

import React from 'react';

import { isHiddenLocalHost } from '@/components/session/sidebar/hosts/hostSessionList';
import { projectMonitoredHost, selectRemoteWork, type RemoteSessionItem } from '@/components/session/sidebar/hosts/remoteHostProjection';
import { useHostsStore } from '@/lib/hosts/hosts-store';

export const useMobileRemoteWork = (enabled: boolean): readonly RemoteSessionItem[] => {
  const hosts = useHostsStore((state) => state.hosts);
  return React.useMemo(
    () => (enabled ? selectRemoteWork(hosts.filter((host) => !isHiddenLocalHost(host)).map(projectMonitoredHost)) : []),
    [enabled, hosts],
  );
};

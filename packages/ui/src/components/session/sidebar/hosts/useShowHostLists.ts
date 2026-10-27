import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { isHiddenLocalHost } from './hostSessionList';

export const useShowHostLists = (isVSCode: boolean = isVSCodeRuntime()) => {
  const monitoredHosts = useMonitoredHosts();
  const shownMonitoredHosts = React.useMemo(
    () => monitoredHosts.hosts.filter((host) => !isHiddenLocalHost(host)),
    [monitoredHosts.hosts],
  );
  const showHostLists = !isVSCode
    && (monitoredHosts.availability === 'ready' || monitoredHosts.availability === 'error')
    && shownMonitoredHosts.length > 0;
  return { monitoredHosts, shownMonitoredHosts, showHostLists };
};

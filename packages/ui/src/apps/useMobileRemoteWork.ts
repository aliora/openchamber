import React from 'react';

import { isHiddenLocalHost } from '@/components/session/sidebar/hosts/hostSessionList';
import {
  projectMonitoredHost,
  selectRemoteAttention,
  selectRemoteRunning,
  selectRemoteScheduled,
  selectRemoteWork,
  type RemoteSessionItem,
  type SidebarRemoteHost,
} from '@/components/session/sidebar/hosts/remoteHostProjection';
import { useHostsStore } from '@/lib/hosts/hosts-store';

const useShownRemoteSelection = (
  enabled: boolean,
  select: (hosts: readonly SidebarRemoteHost[]) => RemoteSessionItem[],
): readonly RemoteSessionItem[] => {
  const hosts = useHostsStore((state) => state.hosts);
  return React.useMemo(
    () => (enabled ? select(hosts.filter((host) => !isHiddenLocalHost(host)).map(projectMonitoredHost)) : []),
    [enabled, hosts, select],
  );
};

export const useMobileRemoteWork = (enabled: boolean, groupScheduled = true): readonly RemoteSessionItem[] => {
  const select = React.useCallback((hosts: readonly SidebarRemoteHost[]) => selectRemoteWork(hosts, groupScheduled), [groupScheduled]);
  return useShownRemoteSelection(enabled, select);
};

export const useMobileRemoteAttention = (enabled: boolean): readonly RemoteSessionItem[] => useShownRemoteSelection(enabled, selectRemoteAttention);

export const useMobileRemoteScheduled = (enabled: boolean): readonly RemoteSessionItem[] => useShownRemoteSelection(enabled, selectRemoteScheduled);

export const useMobileRemoteRunning = (enabled: boolean): readonly RemoteSessionItem[] => useShownRemoteSelection(enabled, selectRemoteRunning);

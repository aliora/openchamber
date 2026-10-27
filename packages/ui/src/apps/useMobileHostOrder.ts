import React from 'react';

import { isHiddenLocalHost } from '@/components/session/sidebar/hosts/hostSessionList';
import { useHostSectionOrder } from '@/components/session/sidebar/hosts/useHostSectionOrder';
import { useHostsStore } from '@/lib/hosts/hosts-store';

export const ACTIVE_HOST_PLACEHOLDER_KEY = 'active';

export const useMobileHostOrder = () => {
  const hosts = useHostsStore((state) => state.hosts);
  const activeHost = useHostsStore((state) => state.activeHost);
  const shownHosts = React.useMemo(() => hosts.filter((host) => !isHiddenLocalHost(host)), [hosts]);
  const descriptors = React.useMemo(() => shownHosts.map((host) => host.descriptor), [shownHosts]);
  const order = useHostSectionOrder(activeHost, ACTIVE_HOST_PLACEHOLDER_KEY, descriptors);
  return React.useMemo(() => ({
    ...order,
    shownHosts,
    activeHost,
    activeRuntimeKey: activeHost?.runtimeKey ?? ACTIVE_HOST_PLACEHOLDER_KEY,
  }), [activeHost, order, shownHosts]);
};

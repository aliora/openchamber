import React from 'react';

import { useHostsStore } from '@/lib/hosts/hosts-store';
import { hostRegistry } from '@/lib/hosts/runtime/host-bindings';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';
import { useI18n } from '@/lib/i18n';
import { describePortableHosts } from '@/lib/settings/portable-sync';
import type { PortableFanOutHost } from '@/lib/settings/portable-fan-out';

export type HostOption = PortableFanOutHost & { focused: boolean };

const LOCAL_RUNTIME_KEY = 'local';

const readHosts = () => hostRegistry.list();

const subscribeHosts = (notify: () => void): (() => void) => hostRegistry.subscribe(notify);

export const useHostOptions = (): HostOption[] => {
  const { t } = useI18n();
  const runtimes = React.useSyncExternalStore(subscribeHosts, readHosts, readHosts);
  const focusedId = useFocusedHostId();
  const rows = useHostsStore((state) => state.hosts);
  const activeHost = useHostsStore((state) => state.activeHost);
  return React.useMemo(() => describePortableHosts(runtimes, { hosts: rows, activeHost }, focusedId)
    .map((host) => ({
      ...host,
      label: host.id === LOCAL_RUNTIME_KEY && host.label === LOCAL_RUNTIME_KEY ? t('settings.sync.host.thisComputer') : host.label,
      focused: host.id === focusedId,
    }))
    .sort((left, right) => Number(right.focused) - Number(left.focused)), [activeHost, focusedId, rows, runtimes, t]);
};

import { create } from 'zustand';

import { toast } from '@/components/ui';
import { useHostsStore, type HostsStore } from '@/lib/hosts/hosts-store';
import { hostRegistry } from '@/lib/hosts/runtime/host-bindings';
import { hostRuntimeFetch } from '@/lib/hosts/runtime/host-fetch';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { createPortableFanOut, type PortableFanOutHost, type PortableFanOutReport } from './portable-fan-out';

type SavedHostLabels = Pick<HostsStore, 'hosts' | 'activeHost'>;

const savedLabelOf = (runtime: HostRuntime, { hosts, activeHost }: SavedHostLabels): string | null => {
  const row = hosts.find((entry) => entry.descriptor.runtimeKey === runtime.id);
  if (row) return row.descriptor.label;
  return activeHost?.runtimeKey === runtime.id ? activeHost.label : null;
};

export const describePortableHosts = (runtimes: readonly HostRuntime[], saved: SavedHostLabels, focusedId: string): PortableFanOutHost[] => (
  runtimes.map((runtime) => ({
    id: runtime.id,
    label: savedLabelOf(runtime, saved) ?? runtime.descriptor.label,
    reachable: runtime.id === focusedId || runtime.status.getState().connection.state === 'live',
    request: (path, init) => hostRuntimeFetch(runtime, path, init),
  }))
);

const listPortableHosts = (): PortableFanOutHost[] => describePortableHosts(hostRegistry.list(), useHostsStore.getState(), hostRegistry.focused().id);

type PortableFanOutReportState = { lastReport: PortableFanOutReport | null };

export const usePortableFanOutReportStore = create<PortableFanOutReportState>()(() => ({ lastReport: null }));

const announceProblems = (report: PortableFanOutReport): void => {
  const hosts = [...new Set(report.problems.map((problem) => problem.label))];
  if (hosts.length === 0) return;
  const dictionary = useI18nStore.getState().dictionary;
  toast.warning(formatMessage(dictionary, 'settings.sync.fanOut.failed', { hosts: hosts.join(', ') }), {
    description: formatMessage(dictionary, 'settings.sync.fanOut.failedHint'),
  });
};

export const portableFanOut = createPortableFanOut({
  listHosts: listPortableHosts,
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  debounceMs: 1_500,
  now: Date.now,
  report: (report) => {
    usePortableFanOutReportStore.setState({ lastReport: report });
    announceProblems(report);
  },
});

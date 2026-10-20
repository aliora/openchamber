import { create } from 'zustand';

import type { HostDescriptor, HostsAvailability, MonitoredHost } from './types';

type HostsStoreState = {
  availability: HostsAvailability;
  hosts: readonly MonitoredHost[];
  /** The saved host the window is connected to, or null when it matches none. Never monitored here. */
  activeHost: HostDescriptor | null;
};

type HostsStoreActions = {
  setAvailability(availability: HostsAvailability): void;
  /** Replaces every row at once, keeping the previous object of a row that did not change. */
  replaceHosts(hosts: readonly MonitoredHost[]): void;
  setActiveHost(descriptor: HostDescriptor | null): void;
  reset(): void;
};

export type HostsStore = HostsStoreState & HostsStoreActions;

const sameDescriptor = (left: HostDescriptor, right: HostDescriptor): boolean => (
  left.id === right.id
  && left.label === right.label
  && left.kind === right.kind
  && left.displayUrl === right.displayUrl
  && left.runtimeKey === right.runtimeKey
  && left.monitored === right.monitored
);

export const useHostsStore = create<HostsStore>()((set, get) => ({
  availability: 'unknown',
  hosts: [],
  activeHost: null,

  setAvailability(availability) {
    if (get().availability !== availability) set({ availability });
  },

  replaceHosts(hosts) {
    const previous = get().hosts;
    const byId = new Map(previous.map((host) => [host.descriptor.id, host]));
    const next = hosts.map((host) => {
      const prior = byId.get(host.descriptor.id);
      return prior && prior.connection === host.connection && prior.snapshot === host.snapshot && sameDescriptor(prior.descriptor, host.descriptor)
        ? prior
        : host;
    });
    if (next.length === previous.length && next.every((host, index) => host === previous[index])) return;
    set({ hosts: next });
  },

  setActiveHost(descriptor) {
    const current = get().activeHost;
    const same = current === descriptor || (current !== null && descriptor !== null && sameDescriptor(current, descriptor));
    if (!same) set({ activeHost: descriptor });
  },

  reset() {
    set({ availability: 'unknown', hosts: [], activeHost: null });
  },
}));

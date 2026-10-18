// The monitored hosts and what is known about each. The host the window is
// connected to is never here: the sidebar reads it from the regular session
// stores. Nothing here holds a credential or a raw address.
//
// Each host's snapshot carries the generation of the monitor run that owns it.
// Generations come from one counter for every host, so a host that leaves and
// comes back (it was active for a while) never reuses one, and a completion
// from an earlier run is dropped.

import { create } from 'zustand';

import type {
  HostConnection,
  HostDescriptor,
  HostProject,
  HostSessionSummary,
  HostSnapshot,
  HostsAvailability,
  MonitoredHost,
} from './types';

type HostsStoreState = {
  availability: HostsAvailability;
  hosts: readonly MonitoredHost[];
  /** The saved host the window is connected to, or null when it matches none. Never monitored here. */
  activeHost: HostDescriptor | null;
};

type HostsStoreActions = {
  setAvailability(availability: HostsAvailability): void;
  /** Replaces the monitored set, in order. Kept hosts keep their connection and list. */
  syncHosts(descriptors: readonly HostDescriptor[]): void;
  setActiveHost(descriptor: HostDescriptor | null): void;
  removeHost(hostId: string): void;
  /** Starts a monitor run: the host's list goes back to loading. Returns the run's generation. */
  beginGeneration(hostId: string): number;
  setConnection(hostId: string, generation: number, connection: HostConnection): void;
  applySnapshot(
    hostId: string,
    generation: number,
    sessions: readonly HostSessionSummary[],
    at: number,
    projects?: readonly HostProject[],
  ): void;
  upsertSession(hostId: string, generation: number, session: HostSessionSummary): void;
  removeSession(hostId: string, generation: number, sessionId: string): void;
  markSnapshotError(hostId: string, generation: number): void;
  reset(): void;
};

export type HostsStore = HostsStoreState & HostsStoreActions;

const EMPTY_SESSIONS: ReadonlyMap<string, HostSessionSummary> = new Map();

const loadingSnapshot = (generation: number): HostSnapshot => ({
  status: 'loading',
  sessions: EMPTY_SESSIONS,
  lastCompleteAt: null,
  generation,
});

const sameDescriptor = (left: HostDescriptor, right: HostDescriptor): boolean => (
  left.id === right.id
  && left.label === right.label
  && left.kind === right.kind
  && left.displayUrl === right.displayUrl
  && left.runtimeKey === right.runtimeKey
  && left.monitored === right.monitored
);

const sameSummary = (left: HostSessionSummary, right: HostSessionSummary): boolean => (
  left.id === right.id
  && left.parentID === right.parentID
  && left.title === right.title
  && left.directory === right.directory
  && left.engine === right.engine
  && left.updatedAt === right.updatedAt
  && left.state === right.state
  && left.outcome === right.outcome
  && left.chat === right.chat
  && left.projectId === right.projectId
);

const sameProjects = (left: readonly HostProject[] | undefined, right: readonly HostProject[] | undefined): boolean => (
  left === right || (
    left !== undefined && right !== undefined && left.length === right.length
    && left.every((project, index) => {
      const other = right[index];
      return project.id === other.id && project.label === other.label && project.path === other.path
        && project.order === other.order && project.isDefault === other.isDefault;
    })
  )
);

/** Builds the next session map, keeping the previous object for every unchanged row. */
const mergeSessions = (
  previous: ReadonlyMap<string, HostSessionSummary>,
  sessions: readonly HostSessionSummary[],
): ReadonlyMap<string, HostSessionSummary> => {
  const next = new Map<string, HostSessionSummary>();
  let changed = previous.size !== sessions.length;
  for (const session of sessions) {
    const prior = previous.get(session.id);
    if (prior && sameSummary(prior, session)) {
      next.set(session.id, prior);
    } else {
      next.set(session.id, session);
      changed = true;
    }
  }
  return changed ? next : previous;
};

let lastGeneration = 0;

export const useHostsStore = create<HostsStore>()((set, get) => {
  const updateHost = (hostId: string, update: (host: MonitoredHost) => MonitoredHost): void => {
    const { hosts } = get();
    const index = hosts.findIndex((host) => host.descriptor.id === hostId);
    if (index === -1) return;
    const next = update(hosts[index]);
    if (next === hosts[index]) return;
    set({ hosts: hosts.map((host, position) => (position === index ? next : host)) });
  };

  /** Applies `update` to the host's snapshot only while `generation` still owns it. */
  const updateOwnedSnapshot = (hostId: string, generation: number, update: (snapshot: HostSnapshot) => HostSnapshot): void => {
    updateHost(hostId, (host) => {
      if (host.snapshot.generation !== generation) return host;
      const snapshot = update(host.snapshot);
      return snapshot === host.snapshot ? host : { ...host, snapshot };
    });
  };

  return {
    availability: 'unknown',
    hosts: [],
    activeHost: null,

    setAvailability(availability) {
      if (get().availability !== availability) set({ availability });
    },

    syncHosts(descriptors) {
      const byId = new Map(get().hosts.map((host) => [host.descriptor.id, host]));
      set({
        hosts: descriptors.map((descriptor) => {
          const existing = byId.get(descriptor.id);
          if (!existing) return { descriptor, connection: { state: 'connecting' }, snapshot: loadingSnapshot(0) };
          return sameDescriptor(existing.descriptor, descriptor) ? existing : { ...existing, descriptor };
        }),
      });
    },

    setActiveHost(descriptor) {
      const current = get().activeHost;
      const same = current === descriptor || (current !== null && descriptor !== null && sameDescriptor(current, descriptor));
      if (!same) set({ activeHost: descriptor });
    },

    removeHost(hostId) {
      const { hosts } = get();
      if (hosts.some((host) => host.descriptor.id === hostId)) {
        set({ hosts: hosts.filter((host) => host.descriptor.id !== hostId) });
      }
    },

    beginGeneration(hostId) {
      lastGeneration += 1;
      const generation = lastGeneration;
      updateHost(hostId, (host) => ({ ...host, connection: { state: 'connecting' }, snapshot: loadingSnapshot(generation) }));
      return generation;
    },

    setConnection(hostId, generation, connection) {
      updateHost(hostId, (host) => (host.snapshot.generation === generation ? { ...host, connection } : host));
    },

    applySnapshot(hostId, generation, sessions, at, projects) {
      updateOwnedSnapshot(hostId, generation, (snapshot) => ({
        status: 'ready',
        sessions: mergeSessions(snapshot.sessions, sessions),
        lastCompleteAt: at,
        generation,
        ...(projects ? { projects: sameProjects(snapshot.projects, projects) ? snapshot.projects : projects } : {}),
      }));
    },

    upsertSession(hostId, generation, session) {
      updateOwnedSnapshot(hostId, generation, (snapshot) => {
        const prior = snapshot.sessions.get(session.id);
        if (prior && sameSummary(prior, session)) return snapshot;
        const sessions = new Map(snapshot.sessions);
        sessions.set(session.id, session);
        return { ...snapshot, sessions };
      });
    },

    removeSession(hostId, generation, sessionId) {
      updateOwnedSnapshot(hostId, generation, (snapshot) => {
        if (!snapshot.sessions.has(sessionId)) return snapshot;
        const sessions = new Map(snapshot.sessions);
        sessions.delete(sessionId);
        return { ...snapshot, sessions };
      });
    },

    markSnapshotError(hostId, generation) {
      updateOwnedSnapshot(hostId, generation, (snapshot) => (
        snapshot.status === 'error' ? snapshot : { ...snapshot, status: 'error' }
      ));
    },

    reset() {
      set({ availability: 'unknown', hosts: [], activeHost: null });
    },
  };
});

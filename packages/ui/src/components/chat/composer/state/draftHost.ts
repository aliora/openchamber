import { hostProjectOrder } from '@/components/session/sidebar/hosts/remoteHostProjection';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';
import { getSafeStorage } from '@/stores/utils/safeStorage';

import type { DraftTargetProject } from './useDraftTarget';

export const ACTIVE_HOST_OPTION_ID = 'active';

const LAST_HOST_STORAGE_KEY = 'openchamber.newSession.lastHostId';

export type DraftHostOption = {
  id: string;
  descriptor: HostDescriptor | null;
  watched: MonitoredHost | null;
};

export type RemoteDraftTarget = {
  host: MonitoredHost;
  projects: DraftTargetProject[];
  defaultProjectId: string | null;
};

export type DraftHostState = {
  options: DraftHostOption[];
  selected: DraftHostOption;
  remote: RemoteDraftTarget | null;
};

const byLabel = (left: MonitoredHost, right: MonitoredHost): number => (
  left.descriptor.label.localeCompare(right.descriptor.label) || left.descriptor.id.localeCompare(right.descriptor.id)
);

const remoteTargetOf = (host: MonitoredHost): RemoteDraftTarget => {
  const projects = [...(host.snapshot.projects ?? [])].sort(hostProjectOrder);
  return {
    host,
    projects: projects.map((project) => ({ id: project.id, path: project.path, label: project.label })),
    defaultProjectId: projects.find((project) => project.isDefault)?.id ?? null,
  };
};

export const resolveDraftHosts = ({ activeHost, hosts, pickedHostId }: {
  activeHost: HostDescriptor | null;
  hosts: readonly MonitoredHost[];
  pickedHostId: string | null;
}): DraftHostState => {
  const active: DraftHostOption = { id: activeHost?.id ?? ACTIVE_HOST_OPTION_ID, descriptor: activeHost, watched: null };
  const others = [...hosts].sort(byLabel).map((host): DraftHostOption => ({ id: host.descriptor.id, descriptor: host.descriptor, watched: host }));
  const options = [active, ...others];
  const picked = others.find((option) => option.id === pickedHostId);
  if (!picked?.watched) return { options, selected: active, remote: null };
  return { options, selected: picked, remote: remoteTargetOf(picked.watched) };
};

export const readLastDraftHostId = (): string | null => getSafeStorage().getItem(LAST_HOST_STORAGE_KEY);

export const rememberDraftHostId = (hostId: string): void => {
  getSafeStorage().setItem(LAST_HOST_STORAGE_KEY, hostId);
};

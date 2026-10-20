import { LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import { redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';

export type HostListState = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  localHostLabel: string | null;
};

export const addHostTo = (state: HostListState, host: DesktopHost): HostListState => ({
  ...state,
  hosts: [host, ...state.hosts],
});

export const renameHostIn = (state: HostListState, hostId: string, draft: string): HostListState => {
  const label = draft.trim();
  if (hostId === LOCAL_HOST_ID) return { ...state, localHostLabel: label || null };
  return {
    ...state,
    hosts: state.hosts.map((host) => (host.id === hostId ? { ...host, label: label || redactSensitiveUrl(host.url) } : host)),
  };
};

export const removeHostFrom = (state: HostListState, hostId: string): HostListState => ({
  ...state,
  hosts: state.hosts.filter((host) => host.id !== hostId),
  defaultHostId: state.defaultHostId === hostId ? LOCAL_HOST_ID : state.defaultHostId,
});

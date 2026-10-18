import React from 'react';
import { create } from 'zustand';

import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import type { MonitoredHost } from '@/lib/hosts/types';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { readLastDraftHostId, rememberDraftHostId, resolveDraftHosts, type DraftHostState } from './draftHost';

type DraftHostPick = { draftId: number; hostId: string };

const useDraftHostPickStore = create<{ pick: DraftHostPick | null }>(() => ({ pick: null }));

const NO_HOSTS: readonly MonitoredHost[] = [];

const pickDraftHost = (draftId: number, hostId: string): void => {
  useDraftHostPickStore.setState({ pick: { draftId, hostId } });
};

export const preselectRememberedDraftHost = (): void => {
  const draft = useSessionUIStore.getState().newSessionDraft;
  const hostId = readLastDraftHostId();
  const host = useHostsStore.getState().hosts.find((entry) => entry.descriptor.id === hostId);
  if (draft.open && host?.connection.state === 'live') pickDraftHost(draft.draftId, host.descriptor.id);
};

export type DraftHostChoice = DraftHostState & {
  visible: boolean;
  selectHost: (hostId: string) => void;
};

export function useDraftHost(enabled: boolean): DraftHostChoice {
  const { availability, hosts, activeHost } = useMonitoredHosts();
  const draftId = useSessionUIStore((state) => state.newSessionDraft.draftId);
  const pick = useDraftHostPickStore((state) => state.pick);
  const pickedHostId = pick?.draftId === draftId ? pick.hostId : null;
  const watchedHosts = availability === 'ready' || availability === 'error' ? hosts : NO_HOSTS;

  const state = React.useMemo(
    () => resolveDraftHosts({ activeHost, hosts: watchedHosts, pickedHostId }),
    [activeHost, pickedHostId, watchedHosts],
  );

  const selectHost = React.useCallback((hostId: string) => {
    rememberDraftHostId(hostId);
    pickDraftHost(draftId, hostId);
  }, [draftId]);

  return React.useMemo(
    () => ({ ...state, visible: enabled && state.options.length > 1, selectHost }),
    [enabled, selectHost, state],
  );
}

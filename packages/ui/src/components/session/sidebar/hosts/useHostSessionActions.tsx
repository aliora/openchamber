import React from 'react';
import { z } from 'zod';
import { toast } from '@/components/ui';
import { canUseElectronDesktopIPC, isVSCodeRuntime } from '@/lib/desktop';
import { getLocalDesktopOrigin, LOCAL_HOST_DEFAULT_LABEL, LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import { desktopLocalClientTokenGet, desktopOpenNewWindowAtUrl, desktopOpenNewWindowForHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { hostOrderKeys } from '@/lib/hosts/host-order';
import { hasHostAppearanceStamp } from '@/lib/settings/host-appearance';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useHostSessionOpener } from '@/lib/hosts/hostSessionOpenerContext';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import type { HostDescriptor } from '@/lib/hosts/types';
import { refreshMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isMacOS } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { RemoteSessionItem } from './remoteHostProjection';

type Translate = ReturnType<typeof useI18n>['t'];

export const localHostDefaultLabel = (t: Translate): string => t(isMacOS() ? 'hosts.local.thisMac' : 'hosts.local.thisComputer');

type LabeledHost = Pick<HostDescriptor, 'id' | 'label' | 'displayUrl'> & { serverId?: string | null };

const resolveHostLabel = (
  host: LabeledHost,
  hostLabels: Record<string, string>,
  serverIdByHostId: ReadonlyMap<string, string>,
  t: Translate,
): string => {
  const serverId = host.serverId || serverIdByHostId.get(host.id) || null;
  const keys = hostOrderKeys({ descriptor: { label: host.label }, serverId });
  const shared = keys.map((key) => hostLabels[key]?.trim()).find(Boolean);
  if (shared) return shared;
  if (host.id !== LOCAL_HOST_ID) return redactSensitiveUrl(host.label.trim() || host.displayUrl);
  const label = host.label.trim();
  return label && label !== LOCAL_HOST_DEFAULT_LABEL ? label : localHostDefaultLabel(t);
};

/** A host's name as the sidebar shows it: shared profile label first, then this machine under the name the user gave it (else in the user's language), or any other label with credentials redacted. */
export const formatHostLabel = (host: LabeledHost, t: Translate): string => (
  resolveHostLabel(host, useUIStore.getState().hostLabels, useHostsStore.getState().serverIdByHostId, t)
);

/** Same name, but a component using it re-renders (and recomputes) when a shared label or server id changes. */
export const useHostLabelFormatter = (): ((host: LabeledHost) => string) => {
  const { t } = useI18n();
  const hostLabels = useUIStore((state) => state.hostLabels);
  const serverIdByHostId = useHostsStore((state) => state.serverIdByHostId);
  return React.useCallback(
    (host) => resolveHostLabel(host, hostLabels, serverIdByHostId, t),
    [hostLabels, serverIdByHostId, t],
  );
};

const DEFAULT_UNMIGRATED_LABELS = new Set(['', 'local', 'standalone', 'instance', 'openchamber']);

const isAddressLikeLabel = (label: string, displayUrl?: string): boolean => {
  const trimmed = label.trim();
  if (displayUrl && (trimmed === displayUrl.trim() || trimmed === redactSensitiveUrl(displayUrl))) return true;
  return /^(https?|relay):\/\//i.test(trimmed);
};

const isCustomLocalHostLabel = (label: string, displayUrl?: string): boolean => (
  !DEFAULT_UNMIGRATED_LABELS.has(label.trim().toLowerCase()) && !isAddressLikeLabel(label, displayUrl)
);

export const saveSharedHostLabel = (
  host: { id: string; label: string; displayUrl?: string; serverId?: string | null },
  nextLabel: string,
): void => {
  if (isAddressLikeLabel(nextLabel, host.displayUrl)) return;
  const serverId = host.serverId || useHostsStore.getState().serverIdByHostId.get(host.id) || null;
  const keys = hostOrderKeys({ descriptor: { label: host.label }, serverId });
  const setHostLabel = useUIStore.getState().setHostLabel;
  for (const key of keys.slice(1)) setHostLabel(key, '');
  if (keys[0]) setHostLabel(keys[0], nextLabel.trim());
};

type MigratedHost = { id: string; label: string; displayUrl?: string; serverId?: string | null };

export const migrateHostAppearanceToServerId = (
  host: MigratedHost,
  explicitServerId?: string | null,
  legacyLabels: readonly string[] = [],
  seedFromHostLabel = true,
): void => {
  const serverId = (explicitServerId || host.serverId || useHostsStore.getState().serverIdByHostId.get(host.id) || '').trim();
  if (!serverId) return;
  const [serverKey] = hostOrderKeys({ descriptor: { label: host.label }, serverId });
  const legacyKeys = [...new Set([host.label, ...legacyLabels].map((label) => hostOrderKeys({ descriptor: { label }, serverId: null })[0]))];
  const { hostLogos, hostLabels, hostAppearanceStamps } = useUIStore.getState();
  const { setHostLogo, setHostLabel } = useUIStore.getState();
  const seed = { seed: true };

  if (!hasHostAppearanceStamp(hostAppearanceStamps, 'logos', serverKey) && !hostLogos[serverKey]) {
    const legacyLogoKey = legacyKeys.find((key) => hostLogos[key]);
    if (legacyLogoKey) setHostLogo(serverKey, hostLogos[legacyLogoKey], seed);
  }

  if (!hasHostAppearanceStamp(hostAppearanceStamps, 'labels', serverKey) && !hostLabels[serverKey]) {
    const legacyLabelKey = legacyKeys.find((key) => hostLabels[key]);
    if (legacyLabelKey) setHostLabel(serverKey, hostLabels[legacyLabelKey], seed);
    else if (seedFromHostLabel && isCustomLocalHostLabel(host.label, host.displayUrl)) setHostLabel(serverKey, host.label, seed);
  }
};

let settingsSyncedOnce = false;
globalThis.window?.addEventListener('openchamber:settings-synced', () => {
  settingsSyncedOnce = true;
});

export const useHostAppearanceMigration = (hosts: ReadonlyArray<MigratedHost>): void => {
  const { t } = useI18n();
  const serverIdByHostId = useHostsStore((state) => state.serverIdByHostId);
  const [synced, setSynced] = React.useState(settingsSyncedOnce);

  React.useEffect(() => {
    if (settingsSyncedOnce) {
      setSynced(true);
      return;
    }
    const onSynced = () => {
      settingsSyncedOnce = true;
      setSynced(true);
    };
    window.addEventListener('openchamber:settings-synced', onSynced);
    return () => window.removeEventListener('openchamber:settings-synced', onSynced);
  }, []);

  React.useEffect(() => {
    if (!synced) return;
    const serverIdOf = (host: MigratedHost): string | null => host.serverId || serverIdByHostId.get(host.id) || null;
    const defaultNamedLocalServerIds = new Set(
      hosts.filter((host) => host.id === LOCAL_HOST_ID && !isCustomLocalHostLabel(host.label, host.displayUrl)).map(serverIdOf),
    );
    for (const host of hosts) {
      const serverId = serverIdOf(host);
      const legacyLabels = host.id === LOCAL_HOST_ID ? [localHostDefaultLabel(t)] : [];
      const seedFromHostLabel = host.id === LOCAL_HOST_ID || !defaultNamedLocalServerIds.has(serverId);
      migrateHostAppearanceToServerId(host, serverId, legacyLabels, seedFromHostLabel);
    }
  }, [hosts, serverIdByHostId, synced, t]);
};

const probedRuntimeKeys = new Set<string>();

export const ensureCurrentHostServerId = (): void => {
  if (!globalThis.window || isVSCodeRuntime()) return;
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey || probedRuntimeKeys.has(runtimeKey)) return;
  const store = useHostsStore.getState();
  if (store.serverIdByHostId.has(LOCAL_HOST_ID) && store.activeHost !== null) return;
  probedRuntimeKeys.add(runtimeKey);
  void runtimeFetch('/api/version', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      const parsed = z.string().trim().min(1).safeParse(body?.serverId);
      return parsed.success ? parsed.data : null;
    })
    .then((serverId) => {
      if (!serverId) {
        probedRuntimeKeys.delete(runtimeKey);
        return;
      }
      const nextStore = useHostsStore.getState();
      nextStore.setServerId(LOCAL_HOST_ID, serverId);
      const active = nextStore.activeHost;
      if (active) {
        nextStore.setServerId(active.id, serverId);
        if (!active.serverId) nextStore.setActiveHost({ ...active, serverId });
      } else {
        nextStore.setActiveHost({
          id: LOCAL_HOST_ID,
          label: LOCAL_HOST_DEFAULT_LABEL,
          kind: 'local',
          displayUrl: window.location?.origin || '',
          runtimeKey,
          monitored: false,
          serverId,
        });
      }
    })
    .catch(() => {
      probedRuntimeKeys.delete(runtimeKey);
    });
};

const PROBLEM_TOAST_KEY = {
  failed: 'sessions.sidebar.hosts.toast.switchFailed',
  missing: 'sessions.sidebar.hosts.toast.missing',
} as const satisfies Record<HostOpenProblem, I18nKey>;

/**
 * What the sidebar and the New session menu do with other hosts: open one of
 * their sessions (moving the focus there), start a draft there, open a
 * host in its own window, refresh, or go to the instance settings.
 */
export const useHostSessionActions = () => {
  const { t } = useI18n();
  const hostSessionOpener = useHostSessionOpener();

  const open = React.useCallback((host: HostDescriptor, target: HostOpenTarget) => {
    const label = formatHostLabel(host, t);
    void hostSessionOpener.open({
      host,
      target,
      onProblem: (problem) => {
        toast.error(t(PROBLEM_TOAST_KEY[problem], { host: label }));
      },
    });
  }, [hostSessionOpener, t]);

  /** Opens a session of another host; with Cmd or Ctrl held, in that host's own window. */
  const openRemoteSession = React.useCallback((item: RemoteSessionItem, inHostWindow: boolean) => {
    if (inHostWindow && hostSessionOpener.openInHostWindow(item.host, item.session.id)) return;
    open(item.host, { kind: 'session', sessionId: item.session.id, directory: item.session.directory });
  }, [hostSessionOpener, open]);

  const openSessionOn = React.useCallback((host: HostDescriptor, sessionId: string, directory: string) => {
    open(host, { kind: 'session', sessionId, directory });
  }, [open]);

  const startDraftOn = React.useCallback((host: HostDescriptor, directory?: string) => {
    open(host, { kind: 'draft', directory });
  }, [open]);

  const openHostWindow = React.useCallback((host: HostDescriptor) => {
    const reportFailure = () => {
      toast.error(t('sessions.sidebar.hosts.toast.newWindowFailed'));
    };
    if (host.id !== LOCAL_HOST_ID) {
      desktopOpenNewWindowForHost(host.id).catch(reportFailure);
      return;
    }
    const localOrigin = getLocalDesktopOrigin();
    if (!localOrigin) {
      reportFailure();
      return;
    }
    void desktopLocalClientTokenGet()
      .then((clientToken) => desktopOpenNewWindowAtUrl(localOrigin, { clientToken: clientToken || null }))
      .catch(reportFailure);
  }, [t]);

  const openInstanceSettings = React.useCallback(() => {
    const ui = useUIStore.getState();
    ui.setSettingsPage('remote-instances');
    ui.setSettingsDialogOpen(true);
  }, []);

  const actions = React.useMemo(() => ({
    openRemoteSession,
    openSessionOn,
    startDraftOn,
    openHostWindow: canUseElectronDesktopIPC() ? openHostWindow : null,
    openInstanceSettings,
    refresh: refreshMonitoredHosts,
  }), [openHostWindow, openInstanceSettings, openRemoteSession, openSessionOn, startDraftOn]);

  return { actions };
};

export type HostSessionActions = ReturnType<typeof useHostSessionActions>['actions'];

import React from 'react';
import { toast } from '@/components/ui';
import { canUseElectronDesktopIPC } from '@/lib/desktop';
import { getLocalDesktopOrigin, LOCAL_HOST_DEFAULT_LABEL, LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import { desktopLocalClientTokenGet, desktopOpenNewWindowAtUrl, desktopOpenNewWindowForHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { useHostSessionOpener } from '@/lib/hosts/hostSessionOpenerContext';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import type { HostDescriptor } from '@/lib/hosts/types';
import { refreshMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isMacOS } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { RemoteSessionItem } from './remoteHostProjection';

type Translate = ReturnType<typeof useI18n>['t'];

export const localHostDefaultLabel = (t: Translate): string => t(isMacOS() ? 'hosts.local.thisMac' : 'hosts.local.thisComputer');

/** A host's name as the sidebar shows it: this machine under the name the user gave it, else in the user's language; any other label with credentials redacted. */
export const formatHostLabel = (host: Pick<HostDescriptor, 'id' | 'label' | 'displayUrl'>, t: Translate): string => {
  if (host.id !== LOCAL_HOST_ID) return redactSensitiveUrl(host.label.trim() || host.displayUrl);
  const label = host.label.trim();
  return label && label !== LOCAL_HOST_DEFAULT_LABEL ? label : localHostDefaultLabel(t);
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

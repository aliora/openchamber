import React from 'react';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { canUseElectronDesktopIPC } from '@/lib/desktop';
import { getLocalDesktopOrigin, LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import { desktopLocalClientTokenGet, desktopOpenNewWindowAtUrl, desktopOpenNewWindowForHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useHostSessionOpener } from '@/lib/hosts/hostSessionOpenerContext';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import type { HostDescriptor } from '@/lib/hosts/types';
import { refreshMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { RemoteSessionItem } from './remoteHostProjection';

type Translate = ReturnType<typeof useI18n>['t'];

/** A host's name as the sidebar shows it: Local in the user's language, any other label with credentials redacted. */
export const formatHostLabel = (host: HostDescriptor, t: Translate): string => (
  host.id === LOCAL_HOST_ID ? t('sessions.sidebar.hosts.local') : redactSensitiveUrl(host.label.trim() || host.displayUrl)
);

const PROBLEM_TOAST_KEY = {
  unreachable: 'sessions.sidebar.hosts.toast.unreachable',
  connecting: 'sessions.sidebar.hosts.toast.connecting',
  failed: 'sessions.sidebar.hosts.toast.switchFailed',
  missing: 'sessions.sidebar.hosts.toast.missing',
} as const satisfies Record<HostOpenProblem, I18nKey>;

/**
 * What the sidebar and the New session menu do with other hosts: open one of
 * their sessions (switching the window there), start a draft there, open a
 * host in its own window, refresh, or go to the instance settings. Render
 * `dialog`: it asks before leaving an unsent message behind.
 */
export const useHostSessionActions = () => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const hostSessionOpener = useHostSessionOpener();

  const open = React.useCallback((host: HostDescriptor, target: HostOpenTarget) => {
    const label = formatHostLabel(host, t);
    // The freshest view of the host, read at the click.
    const connection = useHostsStore.getState().hosts.find((entry) => entry.descriptor.id === host.id)?.connection;
    if (!connection) {
      toast.error(t('sessions.sidebar.hosts.toast.unreachable', { host: label }));
      return;
    }
    void hostSessionOpener.open({
      host,
      connection,
      target,
      confirmLeavingDraft: () => confirm({
        title: t('sessions.sidebar.hosts.leaveDraft.title'),
        message: t('sessions.sidebar.hosts.leaveDraft.message', { host: label }),
        action: t('sessions.sidebar.hosts.leaveDraft.switch'),
        decline: t('sessions.sidebar.hosts.leaveDraft.stay'),
      }),
      onProblem: (problem) => {
        toast.error(t(PROBLEM_TOAST_KEY[problem], { host: label }));
      },
    });
  }, [confirm, hostSessionOpener, t]);

  /** Opens a session of another host; with Cmd or Ctrl held, in that host's own window. */
  const openRemoteSession = React.useCallback((item: RemoteSessionItem, inHostWindow: boolean) => {
    if (inHostWindow && hostSessionOpener.openInHostWindow(item.host, item.session.id)) return;
    open(item.host, { kind: 'session', sessionId: item.session.id, directory: item.session.directory });
  }, [hostSessionOpener, open]);

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
    startDraftOn,
    openHostWindow: canUseElectronDesktopIPC() ? openHostWindow : null,
    openInstanceSettings,
    refresh: refreshMonitoredHosts,
  }), [openHostWindow, openInstanceSettings, openRemoteSession, startDraftOn]);

  return { actions, dialog };
};

export type HostSessionActions = ReturnType<typeof useHostSessionActions>['actions'];

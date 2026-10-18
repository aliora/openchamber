import React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { connectionView } from '@/components/session/sidebar/hosts/hostConnectionView';
import {
  projectMonitoredHost,
  type RemoteSessionGroup,
  type RemoteSessionItem,
  type SidebarRemoteHost,
} from '@/components/session/sidebar/hosts/remoteHostProjection';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '@/components/session/sidebar/sessions/sessionLiveState';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { HostOpenProblem } from '@/lib/hosts/open-host-session';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

import { mobileHostSessionOpener } from './mobileHostSessionOpener';
import { formatRelativeShort } from './mobileSessionFields';
import { mobileSessionTitleClass } from './mobileSessionTitle';

const SESSIONS_PER_GROUP = 7;
const SESSION_TEXT_INSET_PX = 52;
const SESSION_MARK_INSET_PX = 32;

const PROBLEM_TOAST_KEY = {
  unreachable: 'sessions.sidebar.hosts.toast.unreachable',
  connecting: 'sessions.sidebar.hosts.toast.connecting',
  failed: 'sessions.sidebar.hosts.toast.switchFailed',
  missing: 'sessions.sidebar.hosts.toast.missing',
} as const satisfies Record<HostOpenProblem, I18nKey>;

/** Watched hosts in a fixed order, by their label, so a switch never reshuffles them. */
const sortHostsByLabel = (hosts: readonly MonitoredHost[]): MonitoredHost[] => (
  [...hosts].sort((left, right) => (
    left.descriptor.label.localeCompare(right.descriptor.label) || left.descriptor.id.localeCompare(right.descriptor.id)
  ))
);

const MobileHostHeader: React.FC<{
  label: string;
  expanded: boolean;
  onToggle: () => void;
  dotClass: string;
  statusLabel: string;
  showStatus: boolean;
}> = ({ label, expanded, onToggle, dotClass, statusLabel, showStatus }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-2 border-t border-border/60 px-4 pt-2 pb-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded
        ? t('sessions.sidebar.group.collapseAria', { label })
        : t('sessions.sidebar.group.expandAria', { label })}
      style={{ touchAction: 'manipulation' }}
    >
      <RiArrowDownSLine className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', !expanded && '-rotate-90 rtl:rotate-90')} />
      <span dir="auto" className="min-w-0 truncate typography-micro font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span role="img" aria-label={statusLabel} className={cn('size-1.5 shrink-0 rounded-full', dotClass)} />
      {showStatus ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{statusLabel}</span> : null}
    </button>
  );
};

/** The server the phone is connected to, above its full project tree. */
export const MobileActiveHostHeader: React.FC<{
  host: HostDescriptor | null;
  fallbackLabel: string | null;
  expanded: boolean;
  onToggle: () => void;
}> = ({ host, fallbackLabel, expanded, onToggle }) => {
  const { t } = useI18n();
  const connected = useConfigStore((state) => state.isConnected);
  const label = host ? formatHostLabel(host, t) : fallbackLabel ?? t('sessions.sidebar.hosts.current');
  return (
    <MobileHostHeader
      label={label}
      expanded={expanded}
      onToggle={onToggle}
      dotClass={connected ? 'bg-status-success' : 'bg-status-info'}
      statusLabel={t(connected ? 'sessions.sidebar.hosts.connection.live' : 'sessions.sidebar.hosts.connection.connecting')}
      showStatus={!connected}
    />
  );
};

const RemoteSessionRow: React.FC<{ item: RemoteSessionItem; dimmed: boolean; onOpen: (item: RemoteSessionItem) => void }> = ({ item, dimmed, onOpen }) => {
  const { t } = useI18n();
  const { session, liveState } = item;
  const title = session.title.trim() || t('mobile.sessions.untitled');
  const time = formatRelativeShort(session.updatedAt);
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-9 w-full min-w-0 items-center gap-2.5 pe-3.5 text-start transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        dimmed && 'opacity-60',
      )}
      style={{ paddingInlineStart: SESSION_TEXT_INSET_PX, touchAction: 'manipulation' }}
      aria-label={t('sessions.sidebar.hosts.session.openAria', { title, host: formatHostLabel(item.host, t) })}
      onClick={() => onOpen(item)}
    >
      {liveState === 'idle' ? null : (
        <span className="pointer-events-none absolute flex w-3.5 items-center justify-center" style={{ insetInlineStart: SESSION_MARK_INSET_PX, top: 0, bottom: 0 }}>
          <SessionActivityIndicator state={liveState} />
        </span>
      )}
      <span dir="auto" className={cn('block min-w-0 flex-1 truncate typography-ui-label', mobileSessionTitleClass({ active: false, liveState }))}>
        {title}
      </span>
      {liveState === 'idle' ? null : (
        <span className={cn(
          'shrink-0 typography-micro',
          liveState === 'failed' ? 'text-status-error' : isAttentionState(liveState) ? 'text-status-warning' : 'text-muted-foreground',
        )}>
          {t(SESSION_LIVE_STATE_LABEL_KEY[liveState])}
        </span>
      )}
      {time ? <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span> : null}
    </button>
  );
};

const RemoteGroup: React.FC<{ group: RemoteSessionGroup; dimmed: boolean; onOpen: (item: RemoteSessionItem) => void }> = ({ group, dimmed, onOpen }) => {
  const { t } = useI18n();
  const [showAll, setShowAll] = React.useState(false);
  const isChats = group.kind === 'chats';
  const label = isChats
    ? t('mobile.sessions.section.chats')
    : group.project?.label ?? group.sessions[0]?.folderLabel ?? group.directory ?? '';
  const visible = showAll ? group.sessions : group.sessions.slice(0, SESSIONS_PER_GROUP);
  return (
    <section>
      <div className={cn('flex min-h-12 w-full items-center gap-2 px-3 py-1.5', dimmed && 'opacity-60')}>
        <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name={isChats ? 'chat-4' : 'folder'} className="size-5" />
        </span>
        <span dir="auto" className="block min-w-0 flex-1 truncate typography-ui-header font-semibold text-foreground">{label}</span>
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{group.sessions.length}</span>
      </div>
      <div className="pb-2">
        {visible.map((item) => <RemoteSessionRow key={item.session.id} item={item} dimmed={dimmed} onOpen={onOpen} />)}
        {group.sessions.length > SESSIONS_PER_GROUP ? (
          <button
            type="button"
            className="flex min-h-9 w-full items-center gap-2 py-1 pe-3 text-start text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{ paddingInlineStart: SESSION_TEXT_INSET_PX, touchAction: 'manipulation' }}
            onClick={() => setShowAll((current) => !current)}
          >
            <RiArrowDownSLine className={cn('size-4', showAll && 'rotate-180')} />
            <span className="typography-micro">{t(showAll ? 'sessions.sidebar.group.showFewer' : 'sessions.sidebar.group.showMore')}</span>
          </button>
        ) : null}
      </div>
    </section>
  );
};

const TONE_CLASS = { muted: 'text-muted-foreground', warning: 'text-status-warning', error: 'text-status-error' } as const;

const RemoteHostStatus: React.FC<{ host: SidebarRemoteHost; onOpenInstances?: () => void }> = ({ host, onOpenInstances }) => {
  const { t } = useI18n();
  const { connection } = host;
  const className = 'flex items-center gap-1.5 px-4 py-1.5 typography-micro';
  if (connection.state === 'connecting' || (connection.state === 'live' && host.snapshotStatus === 'loading')) {
    return (
      <p className={cn(className, TONE_CLASS.muted)}>
        <Icon name="loader-4" className="size-3 animate-spin" />
        {t('sessions.sidebar.group.empty.loadingSessions')}
      </p>
    );
  }
  if (connection.state === 'live') return <p className={cn(className, TONE_CLASS.muted)}>{t('sessions.sidebar.hosts.status.empty')}</p>;
  const view = connectionView(connection);
  const lastSeen = connection.state === 'backoff' && host.lastCompleteAt !== null ? formatSessionCompactDateLabel(host.lastCompleteAt) : null;
  const offline = view.labelKey === 'sessions.sidebar.hosts.status.offline';
  const text = lastSeen
    ? t(offline ? 'sessions.sidebar.hosts.status.offlineLastSeen' : 'sessions.sidebar.hosts.status.unavailableLastSeen', { time: lastSeen })
    : t(view.labelKey);
  if (connection.state === 'auth-required' && onOpenInstances) {
    return (
      <button
        type="button"
        className={cn(className, 'w-full text-start underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', TONE_CLASS[view.tone])}
        onClick={onOpenInstances}
        style={{ touchAction: 'manipulation' }}
      >
        {text}
      </button>
    );
  }
  return <p className={cn(className, TONE_CLASS[view.tone])}>{text}</p>;
};

/**
 * One collapsible section per watched server: its projects, then folders
 * outside them, each with the sessions' live state. A tap switches the phone
 * to that server and opens the session there.
 */
export const MobileWatchedHosts: React.FC<{
  collapsed: ReadonlySet<string>;
  onToggle: (hostId: string) => void;
  onOpened: () => void;
  onOpenInstances?: () => void;
}> = ({ collapsed, onToggle, onOpened, onOpenInstances }) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const hosts = useHostsStore((state) => state.hosts);
  const sortedHosts = React.useMemo(() => sortHostsByLabel(hosts), [hosts]);

  const openSession = React.useCallback((item: RemoteSessionItem) => {
    const label = formatHostLabel(item.host, t);
    const connection = useHostsStore.getState().hosts.find((entry) => entry.descriptor.id === item.host.id)?.connection;
    if (!connection) {
      toast.error(t('sessions.sidebar.hosts.toast.unreachable', { host: label }));
      return;
    }
    if (connection.state === 'auth-required' && onOpenInstances) {
      onOpenInstances();
      return;
    }
    onOpened();
    void mobileHostSessionOpener.open({
      host: item.host,
      connection,
      target: { kind: 'session', sessionId: item.session.id, directory: item.session.directory },
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
  }, [confirm, onOpenInstances, onOpened, t]);

  return (
    <>
      {sortedHosts.map((entry) => {
        const host = projectMonitoredHost(entry);
        const { id } = host.descriptor;
        const expanded = !collapsed.has(id);
        const view = connectionView(host.connection);
        const dimmed = host.connection.state !== 'live' || host.snapshotStatus !== 'ready';
        return (
          <section key={id} data-host-id={id}>
            <MobileHostHeader
              label={formatHostLabel(host.descriptor, t)}
              expanded={expanded}
              onToggle={() => onToggle(id)}
              dotClass={view.dotClass}
              statusLabel={t(view.labelKey)}
              showStatus={host.connection.state !== 'live'}
            />
            {expanded ? (
              <>
                {dimmed || host.sessions.length === 0 ? <RemoteHostStatus host={host} onOpenInstances={onOpenInstances} /> : null}
                {host.groups.map((group) => <RemoteGroup key={group.id} group={group} dimmed={dimmed} onOpen={openSession} />)}
              </>
            ) : null}
          </section>
        );
      })}
      {dialog}
    </>
  );
};

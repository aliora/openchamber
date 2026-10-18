import React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { connectionView } from '@/components/session/sidebar/hosts/hostConnectionView';
import {
  projectMonitoredHost,
  type RemoteSessionItem,
  type SidebarRemoteHost,
} from '@/components/session/sidebar/hosts/remoteHostProjection';
import { isHiddenLocalHost, selectHostSessionPage, sortHostSessionEntries } from '@/components/session/sidebar/hosts/hostSessionList';
import { SessionProjectChip, SubsessionCountBadge } from '@/components/session/sidebar/sessions/SessionRowChips';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '@/components/session/sidebar/sessions/sessionLiveState';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

import { mobileHostSessionOpener } from './mobileHostSessionOpener';
import { formatRelativeShort } from './mobileSessionFields';
import { mobileSessionTitleClass } from './mobileSessionTitle';

const SESSION_TEXT_INSET_PX = 52;
const SESSION_MARK_INSET_PX = 32;
const SESSION_LEVEL_INDENT_PX = 12;

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
  onNewSession?: () => void;
}> = ({ label, expanded, onToggle, dotClass, statusLabel, showStatus, onNewSession }) => {
  const { t } = useI18n();
  const toggle = (
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
  if (!onNewSession) return toggle;
  return (
    <div className="flex items-center border-t border-border/60 pe-2 [&>button:first-child]:border-t-0">
      {toggle}
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
        aria-label={t('sessions.sidebar.header.actions.newSession')}
        onClick={onNewSession}
        style={{ touchAction: 'manipulation' }}
      >
        <Icon name="add" className="size-4" />
      </button>
    </div>
  );
};

/** The server the phone is connected to, above its full project tree. */
export const MobileActiveHostHeader: React.FC<{
  host: HostDescriptor | null;
  fallbackLabel: string | null;
  expanded: boolean;
  onToggle: () => void;
  onNewSession?: () => void;
}> = ({ host, fallbackLabel, expanded, onToggle, onNewSession }) => {
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
      onNewSession={onNewSession}
    />
  );
};

const RemoteSessionRow: React.FC<{
  item: RemoteSessionItem;
  depth: number;
  dimmed: boolean;
  onOpen: (item: RemoteSessionItem) => void;
}> = ({ item, depth, dimmed, onOpen }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const { session, liveState } = item;
  const title = session.title.trim() || t('mobile.sessions.untitled');
  const time = formatRelativeShort(session.updatedAt);
  const hasChildren = item.children.length > 0;
  const indent = depth * SESSION_LEVEL_INDENT_PX;
  return (
    <>
      <div className={cn('relative flex h-9 w-full min-w-0 items-center', dimmed && 'opacity-60')}>
        {hasChildren ? (
          <button
            type="button"
            className="absolute z-10 flex h-9 w-[30px] items-center justify-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ insetInlineStart: SESSION_MARK_INSET_PX + indent - 8, touchAction: 'manipulation' }}
            aria-expanded={expanded}
            aria-label={t(expanded ? 'sessions.sidebar.session.subsessions.collapse' : 'sessions.sidebar.session.subsessions.expand')}
            onClick={() => setExpanded((current) => !current)}
          >
            <FileTreeChevron expanded={expanded} />
          </button>
        ) : liveState === 'idle' ? null : (
          <span className="pointer-events-none absolute flex w-3.5 items-center justify-center" style={{ insetInlineStart: SESSION_MARK_INSET_PX + indent, top: 0, bottom: 0 }}>
            <SessionActivityIndicator state={liveState} />
          </span>
        )}
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pe-3.5 text-start transition-colors hover:bg-interactive-hover active:bg-interactive-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ paddingInlineStart: SESSION_TEXT_INSET_PX + indent, touchAction: 'manipulation' }}
          aria-label={t('sessions.sidebar.hosts.session.openAria', { title, host: formatHostLabel(item.host, t) })}
          onClick={() => onOpen(item)}
        >
          <span dir="auto" className={cn('block min-w-0 flex-1 truncate typography-ui-label', mobileSessionTitleClass({ active: false, liveState }))}>
            {title}
          </span>
          {item.projectChip ? <SessionProjectChip label={item.projectChip} /> : null}
          {hasChildren ? <SubsessionCountBadge count={item.children.length} /> : null}
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
      </div>
      {expanded ? item.children.map((child) => (
        <RemoteSessionRow key={child.session.id} item={child} depth={depth + 1} dimmed={dimmed} onOpen={onOpen} />
      )) : null}
    </>
  );
};

const RemoteHostSessions: React.FC<{
  host: SidebarRemoteHost;
  dimmed: boolean;
  onOpen: (item: RemoteSessionItem) => void;
}> = ({ host, dimmed, onOpen }) => {
  const { t } = useI18n();
  const [showAll, setShowAll] = React.useState(false);
  const sorted = React.useMemo(() => sortHostSessionEntries(host.sessions.map((item) => ({
    id: item.session.id,
    value: item,
    updatedAt: item.session.updatedAt,
    waiting: isAttentionState(item.liveState) && item.liveState !== 'failed',
    running: item.liveState === 'running' || item.liveState === 'subagent',
    pinned: false,
  }))), [host.sessions]);
  const page = selectHostSessionPage(sorted, showAll);
  const canCollapse = showAll && selectHostSessionPage(sorted, false).hiddenCount > 0;
  return (
    <div className="pb-2">
      {page.visible.map((item) => <RemoteSessionRow key={item.session.id} item={item} depth={0} dimmed={dimmed} onOpen={onOpen} />)}
      {page.hiddenCount > 0 || canCollapse ? (
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 py-1 pe-3 text-start text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ paddingInlineStart: SESSION_TEXT_INSET_PX, touchAction: 'manipulation' }}
          onClick={() => setShowAll((current) => !current)}
        >
          <RiArrowDownSLine className={cn('size-4', showAll && 'rotate-180')} />
          <span className="typography-micro">
            {showAll
              ? t('sessions.sidebar.group.showFewer')
              : t(page.hiddenCount === 1 ? 'sessions.sidebar.group.showMoreSingle' : 'sessions.sidebar.group.showMorePlural', { count: page.hiddenCount })}
          </span>
        </button>
      ) : null}
    </div>
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
  const sortedHosts = React.useMemo(() => sortHostsByLabel(hosts.filter((host) => !isHiddenLocalHost(host))), [hosts]);

  const open = React.useCallback((host: HostDescriptor, target: HostOpenTarget) => {
    const label = formatHostLabel(host, t);
    const connection = useHostsStore.getState().hosts.find((entry) => entry.descriptor.id === host.id)?.connection;
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
  }, [confirm, onOpenInstances, onOpened, t]);

  const openSession = React.useCallback((item: RemoteSessionItem) => {
    open(item.host, { kind: 'session', sessionId: item.session.id, directory: item.session.directory });
  }, [open]);

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
              onNewSession={() => open(host.descriptor, { kind: 'draft', directory: host.newSessionDirectory ?? undefined })}
            />
            {expanded ? (
              <>
                {dimmed || host.sessions.length === 0 ? <RemoteHostStatus host={host} onOpenInstances={onOpenInstances} /> : null}
                <RemoteHostSessions host={host} dimmed={dimmed} onOpen={openSession} />
              </>
            ) : null}
          </section>
        );
      })}
      {dialog}
    </>
  );
};

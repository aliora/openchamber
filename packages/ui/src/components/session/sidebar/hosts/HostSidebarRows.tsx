import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';
import { useHostConnection } from '@/lib/hosts/runtime/useHostConnection';
import { CrossfadeZoneHeader } from '../projects/CrossfadeZoneHeaders';
import type { SortableDragHandleProps } from '../projects/sortableItems';
import { RowMarkTooltip } from '../sessions/RowMarkTooltip';
import { SessionTimelineRowBody } from '../sessions/SessionTimelineRowBody';
import { sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY, sessionRowState } from '../sessions/sessionLiveState';
import type { SessionSidebarHostHeader } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel } from '../utils';
import type { RemoteSessionItem, SidebarRemoteHost } from './remoteHostProjection';
import { connectionView, CONNECTING_VIEW } from './hostConnectionView';
import { HostMark } from '@/components/ui/HostMark';
import { formatHostLabel, type HostSessionActions } from './useHostSessionActions';

// Rows of the host level: a header per host, the line under a watched host
// saying why its list is not current, its Chats and folder headers, and its
// session rows, which open on their host.

// Timeline rows have no gutter: their content sits 10px in.
const ROW_INSET_PX = 10;

const remoteTitleClass = (liveState: RemoteSessionItem['liveState']): string => {
  if (isAttentionState(liveState) || liveState === 'unread') return 'font-semibold text-foreground';
  return liveState === 'running' || liveState === 'subagent' ? 'text-foreground' : 'text-muted-foreground';
};

const hostIcon = (host: HostDescriptor | null): IconName => (host === null || host.kind === 'local' ? 'computer' : 'server');

const ConnectionDot: React.FC<{ dotClass: string; label: string }> = ({ dotClass, label }) => (
  <RowMarkTooltip label={label}>
    <span role="img" aria-label={label} className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
    </span>
  </RowMarkTooltip>
);

/** The focused host's dot follows its own runtime's connection. */
const ActiveHostDot: React.FC = () => {
  const { t } = useI18n();
  const connection = useHostConnection(useFocusedHostId());
  const view = connection ? connectionView(connection) : CONNECTING_VIEW;
  return <ConnectionDot dotClass={view.dotClass} label={t(view.labelKey)} />;
};

export const HostSidebarHeader: React.FC<{
  header: SessionSidebarHostHeader;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: (() => void) | null;
  actions: HostSessionActions;
  dragHandleProps?: SortableDragHandleProps;
}> = ({ header, collapsed, forceExpanded, alwaysShowActions, onToggle, onNewSession, actions, dragHandleProps }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const descriptor = header.kind === 'active' ? header.descriptor : header.host.descriptor;
  const label = descriptor ? formatHostLabel(descriptor, t) : t('sessions.sidebar.hosts.current');
  const view = header.kind === 'monitored' ? connectionView(header.host.connection) : null;
  const revealClass = alwaysShowActions || menuOpen
    ? 'opacity-100'
    : 'opacity-0 pointer-events-none group-hover/host:opacity-100 group-hover/host:pointer-events-auto group-has-[:focus-visible]/host:opacity-100 group-has-[:focus-visible]/host:pointer-events-auto';
  const openHostWindow = actions.openHostWindow;
  // A level above the zones and projects it holds: a rule over it and a
  // small label, the way grouped lists name their groups.
  return <CrossfadeZoneHeader className="sticky top-0 z-20 bg-sidebar" data-sidebar-sticky-header="true">
    <div className="relative group/host -ms-2.5 -me-2 border-t border-border/60">
      <button
        type="button"
        ref={dragHandleProps?.setActivatorNodeRef}
        {...dragHandleProps?.listeners}
        onClick={forceExpanded ? undefined : onToggle}
        disabled={forceExpanded}
        aria-expanded={!collapsed}
        className={cn('group flex w-full items-center gap-1.5 pt-2 pb-1 ps-4 text-start focus-visible:outline-none', onNewSession ? 'pe-16' : 'pe-10', dragHandleProps && !forceExpanded && 'cursor-grab active:cursor-grabbing')}
      >
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-muted-foreground">
          <HostMark host={descriptor} defaultIcon={hostIcon(descriptor)} className={cn('h-3 w-3', !forceExpanded && 'group-hover:hidden')} />
          {!forceExpanded ? <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="hidden h-3.5 w-3.5 group-hover:inline" /> : null}
        </span>
        <span dir="auto" className="min-w-0 truncate typography-micro font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {view ? <ConnectionDot dotClass={view.dotClass} label={t(view.labelKey)} /> : <ActiveHostDot />}
      </button>
      <div className="absolute inset-e-0.5 bottom-0 z-10 flex items-center">
        {onNewSession ? (
          <button
            type="button"
            aria-label={t('sessions.sidebar.header.actions.newSession')}
            onClick={onNewSession}
            className={cn('inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none', revealClass)}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('sessions.sidebar.hosts.actions')}
              className={cn('inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none', revealClass)}
            >
              <Icon name="more-2" className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem onClick={actions.refresh}>
              <Icon name="refresh" className="h-4 w-4" />
              <span>{t('sessions.sidebar.hosts.refresh')}</span>
            </DropdownMenuItem>
            {openHostWindow && descriptor ? (
              <DropdownMenuItem onClick={() => openHostWindow(descriptor)}>
                <Icon name="window" className="h-4 w-4" />
                <span>{t('sessions.sidebar.hosts.openInNewWindow')}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={actions.openInstanceSettings}>
              <Icon name="settings-3" className="h-4 w-4" />
              <span>{t('sessions.sidebar.hosts.settings')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </CrossfadeZoneHeader>;
};

const TONE_CLASS = { muted: 'text-muted-foreground', warning: 'text-status-warning', error: 'text-status-error' } as const;

/**
 * The line under a watched host whose list is not current: why (offline with
 * when it last answered, sign in, update, relay limit), loading, or that it
 * has no sessions. The list below it stays as it was, dimmed.
 */
export const HostStatusLine: React.FC<{ host: SidebarRemoteHost; actions: HostSessionActions }> = ({ host, actions }) => {
  const { t } = useI18n();
  const { connection } = host;
  let content: React.ReactNode;
  let tone: keyof typeof TONE_CLASS = 'muted';
  if (connection.state === 'connecting' || (connection.state === 'live' && host.snapshotStatus === 'loading')) {
    content = <>
      <Icon name="loader-4" className="h-3 w-3 animate-spin" />
      {t('sessions.sidebar.group.empty.loadingSessions')}
    </>;
  } else if (connection.state === 'live') {
    content = t('sessions.sidebar.hosts.status.empty');
  } else {
    const view = connectionView(connection);
    tone = view.tone;
    const lastSeen = connection.state === 'backoff' && host.lastCompleteAt !== null
      ? formatSessionCompactDateLabel(host.lastCompleteAt)
      : null;
    const offline = view.labelKey === 'sessions.sidebar.hosts.status.offline';
    content = lastSeen
      ? t(offline ? 'sessions.sidebar.hosts.status.offlineLastSeen' : 'sessions.sidebar.hosts.status.unavailableLastSeen', { time: lastSeen })
      : t(view.labelKey);
    // Signing in happens on the host's own login screen: the line takes the
    // window there.
    if (connection.state === 'auth-required') {
      content = <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={() => actions.startDraftOn(host.descriptor)}>
        {content}
      </Button>;
    }
  }
  return <div className={cn('py-1 text-start typography-micro', TONE_CLASS[tone])} style={{ paddingInlineStart: ROW_INSET_PX }}>
    <span className="inline-flex flex-wrap items-center gap-1.5">{content}</span>
  </div>;
};

/**
 * A session of another host. A click moves the focus to the host and opens it
 * there; Cmd or Ctrl opens it in the host's own window.
 * In the status filters its second line names the host.
 */
export const RemoteSessionRow: React.FC<{
  item: RemoteSessionItem;
  actions: HostSessionActions;
}> = ({ item, actions }) => {
  const { t } = useI18n();
  const { session, liveState } = item;
  const hostLabel = formatHostLabel(item.host, t);
  const title = session.title.trim() || t('sessions.sidebar.session.untitled');
  const rowState = sessionRowState(liveState);
  // Where projects mix, the host is the row's "where": like a local row that
  // waits on the user, it leaves the folder out for the state word's room.
  const location = (
    <span className="flex min-w-0 items-center gap-1">
      <HostMark host={item.host} defaultIcon={hostIcon(item.host)} className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
      <span dir="auto" className="min-w-0 truncate">{hostLabel}</span>
    </span>
  );
  return <button
    type="button"
    aria-label={t('sessions.sidebar.hosts.session.openAria', { title, host: hostLabel })}
    onClick={(event) => actions.openRemoteSession(item, event.metaKey || event.ctrlKey)}
    style={{ paddingInlineStart: ROW_INSET_PX }}
    className="group relative my-px flex w-full cursor-pointer items-center rounded-md py-1.5 pe-2.5 text-start hover:bg-interactive-hover/60 focus-visible:outline-none"
  >
    <SessionTimelineRowBody
      project={null}
      projectLabel={null}
      title={title}
      titleClassName={remoteTitleClass(liveState)}
      metaLineLead={location}
      statusDot={rowState ? <SessionActivityIndicator state={rowState} tooltip /> : null}
      statusLabel={rowState ? t(SESSION_LIVE_STATE_LABEL_KEY[rowState]) : null}
      statusLabelClassName={rowState === 'failed' ? 'text-destructive' : rowState === 'waiting-input' ? 'text-status-warning' : undefined}
      directoryIndicator={null}
      zombieIndicator={null}
      hideMetaOnHoverClass=""
    />
  </button>;
};

export const RemoteSessionTreeRow: React.FC<{
  item: RemoteSessionItem;
  depth: number;
  expanded: boolean;
  dimmed: boolean;
  onToggle: () => void;
  actions: HostSessionActions;
}> = ({ item, depth, expanded, dimmed, onToggle, actions }) => {
  const { t } = useI18n();
  const { session, liveState } = item;
  const title = session.title.trim() || t('sessions.sidebar.session.untitled');
  const hasChildren = item.children.length > 0;
  const rowState = sessionRowState(liveState);
  const chevron = hasChildren ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={t(expanded ? 'sessions.sidebar.session.subsessions.collapse' : 'sessions.sidebar.session.subsessions.expand')}
      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileTreeChevron expanded={expanded} />
    </button>
  ) : null;
  return <div
    className={cn('group relative my-0.5 flex items-center gap-1.5 rounded-md py-[5px] pe-2.5 hover:bg-interactive-hover/60', dimmed && 'opacity-60')}
    style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
  >
    <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      {chevron}
    </span>
    <button
      type="button"
      aria-label={t('sessions.sidebar.hosts.session.openAria', { title, host: formatHostLabel(item.host, t) })}
      onClick={(event) => actions.openRemoteSession(item, event.metaKey || event.ctrlKey)}
      className="flex min-w-0 flex-1 cursor-pointer items-center text-start focus-visible:outline-none"
    >
      <SessionTimelineRowBody
        compact
        project={null}
        projectLabel={null}
        title={title}
        titleClassName={remoteTitleClass(liveState)}
        statusDot={rowState ? <SessionActivityIndicator state={rowState} tooltip /> : null}
        directoryIndicator={null}
        zombieIndicator={null}
        hideMetaOnHoverClass=""
      />
    </button>
  </div>;
};

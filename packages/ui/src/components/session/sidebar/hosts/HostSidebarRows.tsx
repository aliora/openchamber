import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { CrossfadeZoneHeader } from '../projects/CrossfadeZoneHeaders';
import { RowMarkTooltip } from '../sessions/RowMarkTooltip';
import { SessionTimelineRowBody } from '../sessions/SessionTimelineRowBody';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '../sessions/sessionLiveState';
import type { SessionSidebarHostHeader } from '../sessionSidebarRowModel';
import { formatSessionCompactDateLabel } from '../utils';
import type { RemoteSessionGroup, RemoteSessionItem, SidebarRemoteHost } from './remoteHostProjection';
import { connectionView, LIVE_VIEW } from './hostConnectionView';
import { formatHostLabel, type HostSessionActions } from './useHostSessionActions';

// Rows of the host level: a header per host, the line under a watched host
// saying why its list is not current, its Chats and folder headers, and its
// read-only session rows.

// Timeline rows have no gutter: their content sits 10px in.
const ROW_INSET_PX = 10;

/** The engine's provider, whose logo closes a row's second line. */
const ENGINE_PROVIDER: ReadonlyMap<string, string> = new Map([['claude', 'anthropic'], ['codex', 'openai'], ['antigravity', 'google']]);

const hostIcon = (host: HostDescriptor | null): IconName => (host === null || host.kind === 'local' ? 'computer' : 'server');

const ConnectionDot: React.FC<{ dotClass: string; label: string }> = ({ dotClass, label }) => (
  <RowMarkTooltip label={label}>
    <span role="img" aria-label={label} className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
    </span>
  </RowMarkTooltip>
);

/** The active host's dot follows the window's own connection. */
const ActiveHostDot: React.FC = () => {
  const { t } = useI18n();
  const connected = useConfigStore((state) => state.isConnected);
  return connected
    ? <ConnectionDot dotClass={LIVE_VIEW.dotClass} label={t(LIVE_VIEW.labelKey)} />
    : <ConnectionDot dotClass="bg-status-info" label={t('sessions.sidebar.hosts.connection.connecting')} />;
};

export const HostSidebarHeader: React.FC<{
  header: SessionSidebarHostHeader;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  actions: HostSessionActions;
}> = ({ header, collapsed, forceExpanded, alwaysShowActions, onToggle, actions }) => {
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
        onClick={forceExpanded ? undefined : onToggle}
        disabled={forceExpanded}
        aria-expanded={!collapsed}
        className="group flex w-full items-center gap-1.5 pt-2 pb-1 ps-4 pe-10 text-start focus-visible:outline-none"
      >
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-muted-foreground">
          <Icon name={hostIcon(descriptor)} className={cn('h-3 w-3', !forceExpanded && 'group-hover:hidden')} />
          {!forceExpanded ? <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="hidden h-3.5 w-3.5 group-hover:inline" /> : null}
        </span>
        <span dir="auto" className="min-w-0 truncate typography-micro font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {view ? <ConnectionDot dotClass={view.dotClass} label={t(view.labelKey)} /> : <ActiveHostDot />}
      </button>
      <div className="absolute inset-e-0.5 bottom-0 z-10">
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

/** A watched host's Chats, one of its projects, or one of its folders. */
export const RemoteGroupHeader: React.FC<{ group: RemoteSessionGroup; dimmed: boolean }> = ({ group, dimmed }) => {
  const { t } = useI18n();
  const isChats = group.kind === 'chats';
  const label = isChats ? t('sessions.sidebar.activity.chatsTitle') : group.project?.label ?? group.sessions[0]?.folderLabel ?? group.directory ?? '';
  const content = <div
    className={cn('flex min-w-0 items-center gap-1.5 py-1 typography-ui-label font-medium text-foreground/80', dimmed && 'opacity-60')}
    style={{ paddingInlineStart: ROW_INSET_PX }}
  >
    <Icon name={isChats ? 'chat-4' : 'folder'} className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
    <span dir="auto" className="min-w-0 truncate">{label}</span>
  </div>;
  if (isChats || !group.directory) return content;
  return <Tooltip>
    <TooltipTrigger asChild>{content}</TooltipTrigger>
    <TooltipContent side="right" sideOffset={8}><span dir="ltr">{group.directory}</span></TooltipContent>
  </Tooltip>;
};

/**
 * A session of a watched host, read-only. A click switches the window to the
 * host and opens it there; Cmd or Ctrl opens it in the host's own window.
 * In "Needs you" and the Running filter (`withLocation`) its second line
 * names the host and the folder.
 */
export const RemoteSessionRow: React.FC<{
  item: RemoteSessionItem;
  withLocation: boolean;
  dimmed: boolean;
  actions: HostSessionActions;
}> = ({ item, withLocation, dimmed, actions }) => {
  const { t } = useI18n();
  const { session, liveState } = item;
  const hostLabel = formatHostLabel(item.host, t);
  const title = session.title.trim() || t('sessions.sidebar.session.untitled');
  const attention = isAttentionState(liveState);
  // Where projects mix, the host is the row's "where": like a local row that
  // waits on the user, it leaves the folder out for the state word's room.
  const location = withLocation ? (
    <span className="flex min-w-0 items-center gap-1">
      <Icon name={hostIcon(item.host)} className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
      <span dir="auto" className="min-w-0 truncate">{hostLabel}</span>
    </span>
  ) : null;
  return <button
    type="button"
    aria-label={t('sessions.sidebar.hosts.session.openAria', { title, host: hostLabel })}
    onClick={(event) => actions.openRemoteSession(item, event.metaKey || event.ctrlKey)}
    style={{ paddingInlineStart: ROW_INSET_PX }}
    className={cn(
      'group relative my-px flex w-full cursor-pointer items-center rounded-md py-1.5 pe-2.5 text-start hover:bg-interactive-hover/60 focus-visible:outline-none',
      dimmed && 'opacity-60',
    )}
  >
    <SessionTimelineRowBody
      project={null}
      projectLabel={null}
      title={title}
      titleClassName={attention ? 'font-semibold text-foreground' : liveState === 'running' || liveState === 'subagent' ? 'text-foreground' : 'text-muted-foreground'}
      branchLabel={null}
      metaLineLead={location}
      statusDot={liveState === 'idle' ? null : <SessionActivityIndicator state={liveState} tooltip />}
      statusLabel={liveState === 'idle' ? null : t(SESSION_LIVE_STATE_LABEL_KEY[liveState])}
      statusLabelClassName={liveState === 'failed' ? 'text-status-error' : attention ? 'text-status-warning' : undefined}
      pinnedMarker={null}
      timeSlot={formatSessionCompactDateLabel(session.updatedAt)}
      directoryIndicator={null}
      prBadge={null}
      zombieIndicator={null}
      badges={null}
      providerId={ENGINE_PROVIDER.get(session.engine) ?? null}
      hideMetaOnHoverClass=""
    />
  </button>;
};

import React from 'react';
import { RiArrowDownSLine, RiDragMove2Line } from '@remixicon/react';
import { DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { HostMark } from '@/components/ui/HostMark';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { connectionView, CONNECTING_VIEW } from '@/components/session/sidebar/hosts/hostConnectionView';
import {
  isRemoteScheduledRun,
  projectMonitoredHost,
  type RemoteSessionItem,
  type SidebarRemoteHost,
} from '@/components/session/sidebar/hosts/remoteHostProjection';
import {
  HOST_SESSION_INITIAL_COUNT,
  selectHostSessionPage,
  sortHostSessionEntries,
} from '@/components/session/sidebar/hosts/hostSessionList';
import { SessionProjectChip, SubsessionCountBadge } from '@/components/session/sidebar/sessions/SessionRowChips';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '@/components/session/sidebar/sessions/sessionLiveState';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { toast } from '@/components/ui';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';
import { useHostConnection } from '@/lib/hosts/runtime/useHostConnection';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

import { mobileHostSessionOpener } from './mobileHostSessionOpener';
import { ACTIVE_HOST_PLACEHOLDER_KEY, useMobileHostOrder } from './useMobileHostOrder';
import { formatRelativeShort } from './mobileSessionFields';
import { mobileSessionTitleClass } from './mobileSessionTitle';

const SESSION_TEXT_INSET_PX = 52;
const SESSION_MARK_INSET_PX = 32;
const SESSION_LEVEL_INDENT_PX = 12;

const PROBLEM_TOAST_KEY = {
  failed: 'sessions.sidebar.hosts.toast.switchFailed',
  missing: 'sessions.sidebar.hosts.toast.missing',
} as const satisfies Record<HostOpenProblem, I18nKey>;

const placeWatchedHosts = (
  hosts: readonly MonitoredHost[],
  runtimeKeys: readonly string[],
  activeRuntimeKey: string,
  placement: 'before' | 'after',
): MonitoredHost[] => {
  const activeIndex = runtimeKeys.indexOf(activeRuntimeKey);
  const byRuntimeKey = new Map(hosts.map((host) => [host.descriptor.runtimeKey, host]));
  return runtimeKeys.flatMap((runtimeKey, index) => {
    const host = byRuntimeKey.get(runtimeKey);
    if (!host) return [];
    return (index < activeIndex) === (placement === 'before') ? [host] : [];
  });
};

const MobileHostHeader: React.FC<{
  host: HostDescriptor | null;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  dotClass: string;
  statusLabel: string;
  showStatus: boolean;
  onNewSession?: () => void;
}> = ({ host, label, expanded, onToggle, dotClass, statusLabel, showStatus, onNewSession }) => {
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
      <HostMark host={host} defaultIcon={host?.kind === 'local' ? 'computer' : 'server'} className="size-3.5 shrink-0 text-muted-foreground" />
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
  const connection = useHostConnection(useFocusedHostId());
  const view = connection ? connectionView(connection) : CONNECTING_VIEW;
  const label = host ? formatHostLabel(host, t) : fallbackLabel ?? t('sessions.sidebar.hosts.current');
  return (
    <MobileHostHeader
      host={host}
      label={label}
      expanded={expanded}
      onToggle={onToggle}
      dotClass={view.dotClass}
      statusLabel={t(view.labelKey)}
      showStatus={connection?.state !== 'live'}
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
  const sortOrder = useSessionDisplayStore((state) => state.sessionSortOrder);
  const [shownCount, setShownCount] = React.useState(HOST_SESSION_INITIAL_COUNT);
  const sorted = React.useMemo(() => sortHostSessionEntries(host.sessions.filter((item) => !isRemoteScheduledRun(item)).map((item) => ({
    id: item.session.id,
    value: item,
    title: item.session.title,
    createdAt: item.session.createdAt ?? item.session.updatedAt,
    updatedAt: item.session.updatedAt,
    waiting: isAttentionState(item.liveState) && item.liveState !== 'failed',
    running: item.liveState === 'running' || item.liveState === 'subagent',
    pinned: item.session.pinned === true,
    current: false,
  })), sortOrder), [host.sessions, sortOrder]);
  const page = selectHostSessionPage(sorted, shownCount);
  const showMore = page.hiddenCount > 0;
  return (
    <div className="pb-2">
      {page.visible.map((item) => <RemoteSessionRow key={item.session.id} item={item} depth={0} dimmed={dimmed} onOpen={onOpen} />)}
      {showMore || page.canShowFewer ? (
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 py-1 pe-3 text-start text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ paddingInlineStart: SESSION_TEXT_INSET_PX, touchAction: 'manipulation' }}
          onClick={() => setShownCount(showMore ? Number.POSITIVE_INFINITY : HOST_SESSION_INITIAL_COUNT)}
        >
          <RiArrowDownSLine className={cn('size-4', !showMore && 'rotate-180')} />
          <span className="typography-micro">
            {t(showMore ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}
          </span>
        </button>
      ) : null}
    </div>
  );
};

const TONE_CLASS = { muted: 'text-muted-foreground', warning: 'text-status-warning', error: 'text-status-error' } as const;

const RemoteHostStatus: React.FC<{ host: SidebarRemoteHost; onSignIn: () => void }> = ({ host, onSignIn }) => {
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
  if (connection.state === 'auth-required') {
    return (
      <button
        type="button"
        className={cn(className, 'w-full text-start underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', TONE_CLASS[view.tone])}
        onClick={onSignIn}
        style={{ touchAction: 'manipulation' }}
      >
        {text}
      </button>
    );
  }
  return <p className={cn(className, TONE_CLASS[view.tone])}>{text}</p>;
};

const useMobileHostOpen = (onOpened: () => void) => {
  const { t } = useI18n();
  return React.useCallback((host: HostDescriptor, target: HostOpenTarget) => {
    const label = formatHostLabel(host, t);
    onOpened();
    void mobileHostSessionOpener.open({
      host,
      target,
      onProblem: (problem) => {
        toast.error(t(PROBLEM_TOAST_KEY[problem], { host: label }));
      },
    });
  }, [onOpened, t]);
};

const sessionTarget = (item: RemoteSessionItem): HostOpenTarget => (
  { kind: 'session', sessionId: item.session.id, directory: item.session.directory }
);

export const MobileRemoteWorkRows: React.FC<{ items: readonly RemoteSessionItem[]; onOpened: () => void }> = ({ items, onOpened }) => {
  const { t } = useI18n();
  const open = useMobileHostOpen(onOpened);
  const openSession = React.useCallback((item: RemoteSessionItem) => open(item.host, sessionTarget(item)), [open]);
  return (
    <>
      {items.map((item) => (
        <RemoteSessionRow
          key={`${item.host.id}:${item.session.id}`}
          item={{ ...item, projectChip: formatHostLabel(item.host, t), children: [] }}
          depth={0}
          dimmed={false}
          onOpen={openSession}
        />
      ))}
    </>
  );
};

/**
 * One collapsible section per watched server: its projects, then folders
 * outside them, each with the sessions' live state. A tap moves the focus to
 * that server and opens the session there; a server that needs a sign-in asks
 * for it in its own chat.
 */
export const MobileWatchedHosts: React.FC<{
  placement: 'before' | 'after';
  collapsed: ReadonlySet<string>;
  onToggle: (hostId: string) => void;
  onOpened: () => void;
}> = ({ placement, collapsed, onToggle, onOpened }) => {
  const { t } = useI18n();
  const { shownHosts, runtimeKeys, activeRuntimeKey } = useMobileHostOrder();
  const sortedHosts = React.useMemo(
    () => placeWatchedHosts(shownHosts, runtimeKeys, activeRuntimeKey, placement),
    [activeRuntimeKey, placement, runtimeKeys, shownHosts],
  );
  const open = useMobileHostOpen(onOpened);
  const openSession = React.useCallback((item: RemoteSessionItem) => open(item.host, sessionTarget(item)), [open]);

  return (
    <>
      {sortedHosts.map((entry) => {
        const host = projectMonitoredHost(entry);
        const { id } = host.descriptor;
        const expanded = !collapsed.has(id);
        const view = connectionView(host.connection);
        const dimmed = host.connection.state !== 'live' || host.snapshotStatus !== 'ready';
        const newSession = () => open(host.descriptor, { kind: 'draft', directory: host.newSessionDirectory ?? undefined });
        return (
          <section key={id} data-host-id={id}>
            <MobileHostHeader
              host={host.descriptor}
              label={formatHostLabel(host.descriptor, t)}
              expanded={expanded}
              onToggle={() => onToggle(id)}
              dotClass={view.dotClass}
              statusLabel={t(view.labelKey)}
              showStatus={host.connection.state !== 'live'}
              onNewSession={newSession}
            />
            {expanded ? (
              <>
                {dimmed || host.sessions.length === 0 ? <RemoteHostStatus host={host} onSignIn={newSession} /> : null}
                <RemoteHostSessions host={host} dimmed={dimmed} onOpen={openSession} />
              </>
            ) : null}
          </section>
        );
      })}
    </>
  );
};

const SortableHostReorderRow: React.FC<{ runtimeKey: string; label: string }> = ({ runtimeKey, label }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: runtimeKey });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn('flex items-center gap-1 rounded-xl bg-background px-1 py-1', isDragging && 'shadow-lg shadow-black/20')}
      data-host-reorder={runtimeKey}
    >
      <button
        type="button"
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.sessions.dragHandleAria', { label })}
        {...attributes}
        {...listeners}
      >
        <RiDragMove2Line className="size-4" />
      </button>
      <span dir="auto" className="block min-w-0 flex-1 truncate typography-ui-label font-bold text-muted-foreground">{label}</span>
    </div>
  );
};

export const MobileHostReorderList: React.FC<{ fallbackLabel: string | null }> = ({ fallbackLabel }) => {
  const { t } = useI18n();
  const { shownHosts, runtimeKeys, activeHost, moveHost } = useMobileHostOrder();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelByRuntimeKey = React.useMemo(() => new Map([
    [ACTIVE_HOST_PLACEHOLDER_KEY, fallbackLabel ?? t('sessions.sidebar.hosts.current')],
    ...(activeHost ? [[activeHost.runtimeKey, formatHostLabel(activeHost, t)] as const] : []),
    ...shownHosts.map((host) => [host.descriptor.runtimeKey, formatHostLabel(host.descriptor, t)] as const),
  ]), [activeHost, fallbackLabel, shownHosts, t]);
  if (runtimeKeys.length < 2) return null;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) moveHost(String(active.id), String(over.id));
  };
  return (
    <section className="flex flex-col gap-1.5">
      <p className="px-1 typography-micro font-semibold uppercase tracking-wide text-muted-foreground">{t('mobile.sessions.reorderHostsTitle')}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={[...runtimeKeys]} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {runtimeKeys.map((runtimeKey) => (
              <SortableHostReorderRow key={runtimeKey} runtimeKey={runtimeKey} label={labelByRuntimeKey.get(runtimeKey) ?? runtimeKey} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  );
};

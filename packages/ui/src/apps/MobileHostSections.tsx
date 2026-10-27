import React from 'react';
import { RiArrowDownSLine, RiDragMove2Line } from '@remixicon/react';
import { DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Icon } from '@/components/icon/Icon';
import { HostMark } from '@/components/ui/HostMark';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { connectionView, CONNECTING_VIEW } from '@/components/session/sidebar/hosts/hostConnectionView';
import type { RemoteSessionItem, SidebarRemoteHost } from '@/components/session/sidebar/hosts/remoteHostProjection';
import { SessionProjectChip, SubsessionCountBadge } from '@/components/session/sidebar/sessions/SessionRowChips';
import type { SessionSidebarHostHeader } from '@/components/session/sidebar/sessionSidebarRowModel';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '@/components/session/sidebar/sessions/sessionLiveState';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { toast } from '@/components/ui';
import type { HostOpenProblem, HostOpenTarget } from '@/lib/hosts/open-host-session';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';
import { useHostConnection } from '@/lib/hosts/runtime/useHostConnection';
import type { HostDescriptor } from '@/lib/hosts/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

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
const MobileActiveHostHeader: React.FC<{
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

// `expanded` and `onToggle` hand the subsessions to the list that draws the
// row (the sidebar's row model lists them as rows of their own); without
// them the row opens its children itself.
const RemoteSessionRow: React.FC<{
  item: RemoteSessionItem;
  depth: number;
  dimmed: boolean;
  onOpen: (item: RemoteSessionItem) => void;
  expanded?: boolean;
  onToggle?: () => void;
}> = ({ item, depth, dimmed, onOpen, expanded: listExpanded, onToggle }) => {
  const { t } = useI18n();
  const [ownExpanded, setOwnExpanded] = React.useState(false);
  const expanded = onToggle ? listExpanded === true : ownExpanded;
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
            onClick={() => (onToggle ? onToggle() : setOwnExpanded((current) => !current))}
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
      {expanded && !onToggle ? item.children.map((child) => (
        <RemoteSessionRow key={child.session.id} item={child} depth={depth + 1} dimmed={dimmed} onOpen={onOpen} />
      )) : null}
    </>
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

/**
 * The sidebar row model's host rows, drawn for the phone: a host's header,
 * the line under a watched host saying why its list is not current, and a
 * watched host's session. A tap on a watched host's session moves the focus
 * there and opens it.
 */
export const MobileHostModelHeader: React.FC<{
  header: SessionSidebarHostHeader;
  collapsed: boolean;
  onToggle: () => void;
  onNewSession: (() => void) | null;
  onOpened: () => void;
}> = ({ header, collapsed, onToggle, onNewSession, onOpened }) => {
  const { t } = useI18n();
  const open = useMobileHostOpen(onOpened);
  if (header.kind === 'active') {
    return (
      <MobileActiveHostHeader
        host={header.descriptor}
        fallbackLabel={null}
        expanded={!collapsed}
        onToggle={onToggle}
        onNewSession={onNewSession ?? undefined}
      />
    );
  }
  const { host } = header;
  const view = connectionView(host.connection);
  return (
    <MobileHostHeader
      host={host.descriptor}
      label={formatHostLabel(host.descriptor, t)}
      expanded={!collapsed}
      onToggle={onToggle}
      dotClass={view.dotClass}
      statusLabel={t(view.labelKey)}
      showStatus={host.connection.state !== 'live'}
      onNewSession={() => open(host.descriptor, { kind: 'draft', directory: host.newSessionDirectory ?? undefined })}
    />
  );
};

export const MobileHostModelStatus: React.FC<{ host: SidebarRemoteHost; onOpened: () => void }> = ({ host, onOpened }) => {
  const open = useMobileHostOpen(onOpened);
  return <RemoteHostStatus host={host} onSignIn={() => open(host.descriptor, { kind: 'draft', directory: host.newSessionDirectory ?? undefined })} />;
};

export const MobileHostModelSession: React.FC<{
  item: RemoteSessionItem;
  depth: number;
  dimmed: boolean;
  expanded: boolean;
  /** In a zone that mixes hosts, the row names its host. */
  namesHost: boolean;
  onToggle: () => void;
  onOpened: () => void;
}> = ({ item, depth, dimmed, expanded, namesHost, onToggle, onOpened }) => {
  const { t } = useI18n();
  const open = useMobileHostOpen(onOpened);
  const openSession = React.useCallback((entry: RemoteSessionItem) => open(entry.host, sessionTarget(entry)), [open]);
  return (
    <RemoteSessionRow
      item={namesHost ? { ...item, projectChip: formatHostLabel(item.host, t), children: [] } : item}
      depth={depth}
      dimmed={dimmed}
      onOpen={openSession}
      expanded={expanded}
      onToggle={onToggle}
    />
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

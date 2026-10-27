import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useSessionAiRenameAction } from '@/components/session/useSessionAiRenameAction';
import { SessionClientLabel } from '@/components/session/sidebar/sessions/SessionClientLabel';
import { isAttentionState, SESSION_LIVE_STATE_LABEL_KEY } from '@/components/session/sidebar/sessions/sessionLiveState';
import { isMultiLineTimelineContext, sessionExpansionKey, type SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import type { SessionNode } from '@/components/session/sidebar/types';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { isSessionPinned } from '@/lib/sessionPins';
import { isDoneSuggested } from '@/lib/sessionWorkMetadata';
import { collectSessionWorkInWork } from '@/components/session/sidebar/works/sidebarWorks';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';
import { useHasSessionTurnDuration } from '@/sync/session-turn-duration';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSessionDirectory } from '../mobileSessionFields';
import { MobileProjectIcon } from '../MobileProjectIcon';
import { MobileSessionRenameForm } from '../MobileSessionRenameForm';
import { MobileSessionGoalGlyph, MobileSessionPendingBadges } from '../MobileSessionStateBadges';
import { MobileSessionRowActions, MobileSwipeActionsRow, ROW_ACTION_SLOT_WIDTH, ROW_ACTIONS_WIDTH } from '../MobileSessionSwipe';
import { mobileSessionTitleClass } from '../mobileSessionTitle';
import { usePendingRequests } from '../usePendingRequests';
import { pendingBadgesBesideLiveState, useMobileSessionLiveState } from '../useMobileSessionLiveState';
import { renameMobileSession, runMobileSubtreeAction, selectMobileSession, toggleMobileSessionPin, toggleMobileSessionWork } from './mobileSessionActions';
import type { MobileTreeGeometry } from './mobileSidebarGeometry';
import { useMobileRowSwipe, useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MOBILE_ACTIVE_ROW_CLASS, MobileRowChevron, MobileSlotChevron, MobileTwoLineLayout } from './mobileRowParts';

type SessionRowModel = Extract<SessionSidebarRow, { kind: 'session' }>;

const collectDescendantIds = (node: SessionNode): string[] => node.children.flatMap((child) => [child.session.id, ...collectDescendantIds(child)]);

/**
 * A session in the phone's list: the desktop row's content for a thumb. One
 * line is a tree row, its subsession chevron in the slot left of the title
 * and its live state on the right before the time. Two lines put the state
 * in a word and the engine on the second, with the chevron as its first
 * icon; branch, PR and issue badges stay in the chat. Swiping reveals
 * archive, pin, Track or Done, delete, rename and Copy ID.
 */
export const MobileSessionRow: React.FC<{
  row: SessionRowModel;
  geometry: MobileTreeGeometry;
  toggleParent: (key: string) => void;
}> = ({ row, geometry, toggleParent }) => {
  const { t } = useI18n();
  const actions = useMobileSidebarActions();
  const { node, depth } = row;
  const session = node.session;
  const directory = getSessionDirectory(session);
  const { revealed, armed, renaming } = useMobileRowSwipe(row.key);
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  const aiRename = useSessionAiRenameAction(session.id, session.directory, revealed || renaming);
  const isCurrent = useSessionUIStore((state) => state.currentSessionId === session.id);
  // A run's overview covers the session, and then the run's row is the selected one.
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const active = isCurrent && !runOverviewOpen;
  const hasChildren = node.children.length > 0;
  const expanded = row.forceExpanded === true || row.expanded === true;
  // A folded row stands for its subsessions too: their waiting requests count here.
  const familyIds = React.useMemo(
    () => (hasChildren && !expanded ? [session.id, ...collectDescendantIds(node)] : [session.id]),
    [expanded, hasChildren, node, session.id],
  );
  const pendingRequests = usePendingRequests(familyIds);
  // Live state, ranked as in the desktop sidebar: a waiting request, an
  // unseen failure, a running turn, then an unseen finished turn.
  const { liveState: rowState, turnActivity } = useMobileSessionLiveState(session.id, active, pendingRequests);
  const isStreaming = turnActivity !== null;
  const showUnread = rowState === 'unread';
  const hasActivityDuration = useHasSessionTurnDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnread) && hasActivityDuration;
  const pendingBadges = pendingBadgesBesideLiveState(pendingRequests, rowState);
  const topLevel = !session.parentID;
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  // Only a work's own row tracks it, for every session of it: what nests in
  // a work is tracked and finished with it.
  const ownsWork = sessionWorkEnabled && row.ownsWork && topLevel && !isChatDirectoryPath(directory);
  const sessionsInWork = React.useMemo(() => (ownsWork ? collectSessionWorkInWork(node) : []), [node, ownsWork]);
  const work = ownsWork
    ? { inWork: sessionsInWork.length > 0, onToggle: () => { void toggleMobileSessionWork(session, sessionsInWork, t); } }
    : undefined;
  const pinned = useSessionPinnedStore((state) => isSessionPinned(state.ids, directory || null, session.id));
  const pin = topLevel && directory ? { pinned, onToggle: () => toggleMobileSessionPin(session, pinned, t) } : undefined;
  const inZone = row.renderContext === 'timeline-mixed' || row.renderContext === 'mixed-compact';
  // With the Pinned zone shown, the zones need no pin: it says it in its header.
  const pinnedZoneShown = useSessionDisplayStore((state) => state.showPinnedSection) && inZone;
  const showDoneHint = Boolean(work?.inWork) && !isStreaming && isDoneSuggested(session);
  // Two lines in a zone with Detailed rows on ('timeline-mixed'), and under a
  // project for the works there (`detailed`); what nests inside stays one line.
  const detailed = row.detailed === true || isMultiLineTimelineContext(row.renderContext);
  const project = useProjectsStore(React.useCallback(
    (state) => (detailed && row.renderContext === 'timeline-mixed' && row.projectId ? state.projects.find((entry) => entry.id === row.projectId) ?? null : null),
    [detailed, row.projectId, row.renderContext],
  ));
  const toggle = hasChildren && !row.forceExpanded
    ? () => toggleParent(sessionExpansionKey(row.renderContext, row.archived, session.id))
    : undefined;

  const setRevealed = (next: boolean) => useMobileSidebarRowsStore.getState().setRevealed(row.key, next);
  const select = () => {
    // A tap while the actions are out only puts them away.
    if (revealed) {
      setRevealed(false);
      return;
    }
    selectMobileSession(session, row.projectId, actions.close);
  };
  const stopRename = () => useMobileSidebarRowsStore.getState().stopRename();
  const liveState = aiRename.pending
    ? <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
    : rowState === 'idle' ? null : <SessionActivityIndicator state={rowState} />;
  // No date, as on the desktop: the list is ordered by recency. A turn's
  // duration shows while it runs and until it is read.
  const timeSlot = showActivityDuration
    ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="shrink-0 typography-micro" />
    : null;
  const pinMarker = pinned && !pinnedZoneShown
    ? <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" aria-label={t('sessions.sidebar.session.status.pinned')} />
    : null;
  const doneHint = showDoneHint
    ? <Icon name="check" className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('sessions.sidebar.session.work.doneSuggested')} />
    : null;
  const titleText = (
    <span dir="auto" className={cn('block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label', mobileSessionTitleClass({ active, liveState: rowState }))}>
      {title}
    </span>
  );
  const renameForm = (indent: number, className?: string) => (
    <MobileSessionRenameForm
      initialTitle={title}
      indent={indent}
      aiRename={aiRename}
      className={className}
      onSubmit={(next) => {
        stopRename();
        void renameMobileSession(session.id, next, t);
      }}
      onCancel={stopRename}
    />
  );

  let content: React.ReactNode;
  if (detailed) {
    const lead = project ? <MobileProjectIcon project={project} size="xs" /> : null;
    content = (
      <MobileTwoLineLayout
        indent={geometry.detailedLeft(depth)}
        onSelect={renaming ? undefined : select}
        chevron={toggle ? <MobileRowChevron expanded={expanded} label={title} kind="session" onToggle={toggle} /> : null}
        firstLine={renaming
          ? renameForm(0, 'h-[1lh] pe-0 typography-ui-label [&_button]:size-6 [&_button>svg]:size-3.5')
          : <>
            {titleText}
            {pinMarker}
            {liveState}
            {doneHint}
            {timeSlot}
          </>}
        secondLine={<>
          {lead}
          {rowState === 'idle' ? null : (
            <span className={cn(
              'shrink-0 typography-micro',
              rowState === 'failed' ? 'text-status-error' : isAttentionState(rowState) ? 'text-status-warning' : undefined,
            )}>
              {t(SESSION_LIVE_STATE_LABEL_KEY[rowState])}
            </span>
          )}
          <SessionClientLabel providerId={session.model?.providerID} modelId={session.model?.id} className="ms-auto typography-micro" />
          <span className="flex shrink-0 items-center gap-1.5">
            <MobileSessionGoalGlyph session={session} />
            <MobileSessionPendingBadges {...pendingBadges} />
          </span>
        </>}
      />
    );
  } else {
    // The slot holds the subsession chevron only; the live state sits on the
    // right before the time, as on every row.
    content = <>
      {toggle ? (
        <MobileSlotChevron slotLeft={geometry.slotLeft(depth)}>
          <MobileRowChevron expanded={expanded} label={title} kind="session" onToggle={toggle} />
        </MobileSlotChevron>
      ) : null}
      {renaming ? renameForm(geometry.textLeft(depth)) : (
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pe-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{ paddingInlineStart: geometry.textLeft(depth), touchAction: 'manipulation' }}
          onClick={select}
        >
          {titleText}
          {pinMarker}
          {doneHint}
          <MobileSessionGoalGlyph session={session} />
          <MobileSessionPendingBadges {...pendingBadges} />
          {liveState}
          <SessionClientLabel providerId={session.model?.providerID} modelId={session.model?.id} iconOnly />
          {timeSlot}
        </button>
      )}
    </>;
  }

  return (
    <MobileSwipeActionsRow
      actionsWidth={ROW_ACTIONS_WIDTH + (work ? ROW_ACTION_SLOT_WIDTH : 0) + (pin ? ROW_ACTION_SLOT_WIDTH : 0)}
      revealed={revealed}
      onRevealedChange={setRevealed}
      dataActiveSession={active}
      contentClassName={cn('relative flex w-full items-center bg-background transition-colors', active && MOBILE_ACTIVE_ROW_CLASS)}
      actions={(
        <MobileSessionRowActions
          sessionId={session.id}
          title={title}
          revealed={revealed}
          confirmingDelete={armed}
          onArchive={() => { setRevealed(false); void runMobileSubtreeAction('archive', session, t); }}
          onRequestDelete={() => useMobileSidebarRowsStore.getState().arm(row.key)}
          onConfirmDelete={() => { setRevealed(false); void runMobileSubtreeAction('delete', session, t); }}
          onRequestRename={() => useMobileSidebarRowsStore.getState().startRename(row.key)}
          onRevealedChange={setRevealed}
          work={work}
          pin={pin}
        />
      )}
    >
      {content}
    </MobileSwipeActionsRow>
  );
};

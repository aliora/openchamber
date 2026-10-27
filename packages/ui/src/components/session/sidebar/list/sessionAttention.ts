import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { isSessionUnreadWithError } from '@/sync/session-unread';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { isSessionPinned } from '@/lib/sessionPins';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { isSessionScheduledInMetadata } from '@/lib/sessionScheduled';

// Which top-level sessions the "Needs you" zone and the Running filter list.
// Membership comes from the live indexes only: the cross-directory
// blocking-request index, the sessions' unread records and the live status index.
// Those change on asks, replies, turn ends and run starts, never per streamed
// token, and each subscription below re-renders only when the set of session
// ids changes.

/** Subagents nest; a deeper chain than this is treated as unrelated. */
const MAX_PARENT_DEPTH = 8;

const EMPTY_IDS: ReadonlySet<string> = new Set();

const joinIds = (ids: Iterable<string>): string => [...ids].sort().join('\n');
const splitIds = (signature: string): ReadonlySet<string> => (signature ? new Set(signature.split('\n')) : EMPTY_IDS);

/** Sessions with a permission request, a question or a waiting page. */
export const useBlockingSessionIds = (): ReadonlySet<string> => {
  const signature = useGlobalBlockingRequestsStore((state) => joinIds(state.bySession.keys()));
  return React.useMemo(() => splitIds(signature), [signature]);
};

/** Sessions whose latest finished turn failed and nobody has looked at. */
export const useFailedUnseenSessionIds = (): ReadonlySet<string> => {
  const signature = useGlobalSessionsStore((state) => {
    const ids: string[] = [];
    for (const [sessionId, session] of state.entityById) {
      if (isSessionUnreadWithError(session)) ids.push(sessionId);
    }
    return joinIds(ids);
  });
  return React.useMemo(() => splitIds(signature), [signature]);
};

/**
 * Sessions running now (their own turn, or a background command), read only
 * while `enabled`, so the plain list does not rebuild whenever a turn starts
 * or ends.
 */
export const useRunningSessionIds = (enabled: boolean, includeShells = true): ReadonlySet<string> => {
  const active = useGlobalSessionStatusStore((state) => (enabled ? state.activeSessionIds : EMPTY_IDS));
  const shells = useBackgroundShellsStore((state) => (enabled && includeShells ? state.sessionIds : EMPTY_IDS));
  return React.useMemo(() => (shells.size === 0 ? active : new Set([...active, ...shells])), [active, shells]);
};

const resolveRootId = (sessionId: string, sessionById: ReadonlyMap<string, Session>): string => {
  let current = sessionId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parentId = sessionById.get(current)?.parentID;
    if (!parentId || !sessionById.has(parentId)) return current;
    current = parentId;
  }
  return current;
};

/**
 * The listed top-level sessions, in `orderedSessions` order, whose tree holds
 * one of `treeIds` or which are themselves one of `rootIds`. A subagent's
 * request blocks the run of its top-level session, so it lists that session;
 * a failure counts only for the session the user started.
 */
export const selectListedRootSessions = ({
  orderedSessions,
  sessionById,
  treeIds,
  rootIds = EMPTY_IDS,
}: {
  orderedSessions: readonly Session[];
  sessionById: ReadonlyMap<string, Session>;
  treeIds: ReadonlySet<string>;
  rootIds?: ReadonlySet<string>;
}): Session[] => {
  if (treeIds.size === 0 && rootIds.size === 0) return [];
  const wanted = new Set(rootIds);
  for (const sessionId of treeIds) wanted.add(resolveRootId(sessionId, sessionById));
  return orderedSessions.filter((session) => (
    wanted.has(session.id) && !session.parentID && !session.time?.archived
  ));
};

/** Top-level sessions listed in the Pinned and In work zones. */
type ZoneSessions = { pinned: readonly Session[]; work: readonly Session[] };

/**
 * The Pinned and In work zones, in `orderedSessions` order: top-level,
 * unarchived project sessions (chats keep their pins in Chats and are never
 * in work). A session is listed once among the zones: pinned beats in work,
 * and one that "Needs you" lists (`attentionIds`) is not in In work. Pinned
 * keeps its sessions; only a search, which lists each match once, leaves
 * the ones "Needs you" lists out of Pinned too.
 */
export const selectZoneSessions = ({
  orderedSessions,
  pinnedSessionIds,
  attentionIds,
  showPinned,
  showWork,
  groupScheduled = true,
  search,
}: {
  orderedSessions: readonly Session[];
  pinnedSessionIds: ReadonlySet<string>;
  attentionIds: ReadonlySet<string>;
  showPinned: boolean;
  showWork: boolean;
  groupScheduled?: boolean;
  search: boolean;
}): ZoneSessions => {
  const pinned: Session[] = [];
  const work: Session[] = [];
  if (!showPinned && !showWork) return { pinned, work };
  for (const session of orderedSessions) {
    if (session.parentID || session.time?.archived || isChatDirectoryPath(session.directory)) continue;
    const needsUser = attentionIds.has(session.id);
    if (needsUser && search) continue;
    if (showPinned && isSessionPinned(pinnedSessionIds, session.directory, session.id)) pinned.push(session);
    else if (showWork && !needsUser && !(groupScheduled && isSessionScheduledInMetadata(session)) && isSessionInWork(session)) work.push(session);
  }
  return { pinned, work };
};

export const selectScheduledSessions = ({
  orderedSessions,
  pinnedSessionIds,
  attentionIds,
  search,
}: {
  orderedSessions: readonly Session[];
  pinnedSessionIds: ReadonlySet<string>;
  attentionIds: ReadonlySet<string>;
  search: boolean;
}): Session[] => orderedSessions.filter((session) => (
  !session.parentID
  && !session.time?.archived
  && isSessionScheduledInMetadata(session)
  && !isSessionPinned(pinnedSessionIds, session.directory, session.id)
  && !(search && attentionIds.has(session.id))
));

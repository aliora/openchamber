import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useNotificationStore } from '@/sync/notification-store';

// Which top-level sessions the "Needs you" zone and the Running filter list.
// Membership comes from the live indexes only: the cross-directory
// blocking-request index, the notification store and the live status index.
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
  const signature = useNotificationStore((state) => joinIds(Object.keys(state.index.session.unseenLatestIsError)));
  return React.useMemo(() => splitIds(signature), [signature]);
};

/**
 * Sessions running now (their own turn, or a background command), read only
 * while `enabled`, so the plain list does not rebuild whenever a turn starts
 * or ends.
 */
export const useRunningSessionIds = (enabled: boolean): ReadonlySet<string> => {
  const active = useGlobalSessionStatusStore((state) => (enabled ? state.activeSessionIds : EMPTY_IDS));
  const shells = useBackgroundShellsStore((state) => (enabled ? state.sessionIds : EMPTY_IDS));
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

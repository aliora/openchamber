import { useCallback } from 'react';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { isSessionUnreadWithError, useSessionUnread } from '@/sync/session-unread';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { resolveSessionLiveState, type SessionLiveState } from '@/components/session/sidebar/sessions/sessionLiveState';
import type { PendingRequests } from './usePendingRequests';

/**
 * A phone row's live state, ranked the way the desktop sidebar ranks it
 * (`sessionLiveState.ts`). `pending` already covers the subsessions the row
 * stands for. The open session is on screen, so it is never unread or an
 * unseen failure.
 */
export const useMobileSessionLiveState = (sessionId: string, active: boolean, pending: PendingRequests) => {
  const unread = useSessionUnread(sessionId);
  const failedUnseen = useGlobalSessionsStore(useCallback(
    (state) => isSessionUnreadWithError(state.entityById.get(sessionId)),
    [sessionId],
  ));
  const turnActivity = useSessionTurnActivity(sessionId);
  const liveState = resolveSessionLiveState({
    pendingPermission: pending.hasPermission,
    pendingInput: pending.hasForm,
    failedUnseen: failedUnseen && !active,
    turnActivity,
    unread: unread && !active,
  });
  return { liveState, turnActivity };
};

/** The request badges a row still needs once its live mark shows the request that ranks first. */
export const pendingBadgesBesideLiveState = (pending: PendingRequests, liveState: SessionLiveState): PendingRequests => ({
  hasPermission: pending.hasPermission && liveState !== 'waiting-permission',
  hasForm: pending.hasForm && liveState !== 'waiting-input',
});

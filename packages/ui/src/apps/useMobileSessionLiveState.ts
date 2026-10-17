import { useSessionTurnActivity } from '@/sync/global-session-status';
import { useSessionFailedUnseen, useSessionUnseenCount } from '@/sync/notification-store';
import { resolveSessionLiveState, type SessionLiveState } from '@/components/session/sidebar/sessions/sessionLiveState';
import type { PendingRequests } from './usePendingRequests';

/**
 * A phone row's live state, ranked the way the desktop sidebar ranks it
 * (`sessionLiveState.ts`). `pending` already covers the subsessions the row
 * stands for. The open session is on screen, so it is never unread or an
 * unseen failure.
 */
export const useMobileSessionLiveState = (sessionId: string, active: boolean, pending: PendingRequests) => {
  const unseenCount = useSessionUnseenCount(sessionId);
  const failedUnseen = useSessionFailedUnseen(sessionId);
  const turnActivity = useSessionTurnActivity(sessionId);
  const liveState = resolveSessionLiveState({
    pendingPermission: pending.hasPermission,
    pendingInput: pending.hasForm,
    failedUnseen: failedUnseen && !active,
    turnActivity,
    unread: unseenCount > 0 && !active,
  });
  return { liveState, turnActivity };
};

/** The request badges a row still needs once its live mark shows the request that ranks first. */
export const pendingBadgesBesideLiveState = (pending: PendingRequests, liveState: SessionLiveState): PendingRequests => ({
  hasPermission: pending.hasPermission && liveState !== 'waiting-permission',
  hasForm: pending.hasForm && liveState !== 'waiting-input',
});

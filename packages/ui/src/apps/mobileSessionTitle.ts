import { isAttentionState, isRunningState, type SessionLiveState } from '@/components/session/sidebar/sessions/sessionLiveState';

/**
 * A session title carries the session's state, as in the desktop sidebar: a
 * finished turn nobody has seen, a failure nobody has seen and a request
 * waiting on the user read semibold, a running turn at full strength, the
 * rest a step below. The open session takes the selection's text colour, as
 * on the desktop.
 */
export const mobileSessionTitleClass = ({ active, liveState }: {
  active: boolean;
  liveState: SessionLiveState;
}): string => {
  if (active) return 'text-interactive-selection-foreground';
  if (liveState === 'unread' || isAttentionState(liveState)) return 'font-semibold text-foreground';
  return isRunningState(liveState) ? 'text-foreground' : 'oc-title-rest';
};

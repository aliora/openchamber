/**
 * What a session row says about the session right now, in the order the user
 * has to act on it: a request waiting on them, then a failed turn they have
 * not seen, then work in progress, then a finished turn they have not read.
 *
 * Every input comes from a live source (the blocking-request index, the
 * notification store, the live status index); history never decides it.
 * Desktop rows, the mobile sheet and the "Needs you" zone all read it here,
 * so a session reads the same everywhere.
 */
export type SessionLiveState =
  | 'waiting-permission'
  | 'waiting-input'
  | 'failed'
  | 'running'
  | 'workflow'
  | 'subagent'
  | 'shell'
  | 'unread'
  | 'idle';

/** A turn the session keeps open: its own run, a workflow run it proposed, or a background subagent or command. */
type SessionTurnActivity = 'running' | 'workflow' | 'subagent' | 'shell';

export type SessionLiveStateInput = {
  /** A permission request of the session (or of a subsession the row stands for) waits on the user. */
  pendingPermission: boolean;
  /** A question or a page that waits for the user's answer. */
  pendingInput: boolean;
  /** The latest finished turn failed and the user has not looked at it. */
  failedUnseen: boolean;
  turnActivity: SessionTurnActivity | null;
  /** A finished turn the user has not seen. */
  unread: boolean;
};

/**
 * Precedence: waiting on a permission > waiting on an answer > failed >
 * running > unread > idle.
 */
export const resolveSessionLiveState = (input: SessionLiveStateInput): SessionLiveState => {
  if (input.pendingPermission) return 'waiting-permission';
  if (input.pendingInput) return 'waiting-input';
  if (input.failedUnseen) return 'failed';
  if (input.turnActivity) return input.turnActivity;
  if (input.unread) return 'unread';
  return 'idle';
};

/** States that put a session in the "Needs you" zone. */
export const isAttentionState = (state: SessionLiveState): boolean => (
  state === 'waiting-permission' || state === 'waiting-input' || state === 'failed'
);

/** States drawn as work in progress. */
export const isRunningState = (state: SessionLiveState): boolean => (
  state === 'running' || state === 'workflow' || state === 'subagent' || state === 'shell'
);

/**
 * What a sidebar row shows of its state: running, waiting on the user, failed,
 * or done and not yet seen. Every other distinction stays in the ranking above
 * and in the chat.
 */
type SessionRowState = 'running' | 'waiting-input' | 'failed' | 'unread';

export const sessionRowState = (state: SessionLiveState): SessionRowState | null => {
  if (state === 'waiting-permission' || state === 'waiting-input') return 'waiting-input';
  if (isRunningState(state)) return 'running';
  if (state === 'failed' || state === 'unread') return state;
  return null;
};

/** The state in a word, on the second line of two-line rows. */
export const SESSION_LIVE_STATE_LABEL_KEY = {
  'waiting-permission': 'sessions.sidebar.session.liveState.waitingPermission',
  'waiting-input': 'sessions.sidebar.session.liveState.waitingInput',
  failed: 'sessions.sidebar.session.liveState.failed',
  running: 'sessions.sidebar.session.liveState.running',
  workflow: 'sessions.sidebar.session.status.workflowRunning',
  subagent: 'sessions.sidebar.session.liveState.subagent',
  shell: 'sessions.sidebar.session.liveState.shell',
  unread: 'sessions.sidebar.session.liveState.unread',
} as const satisfies Record<Exclude<SessionLiveState, 'idle'>, string>;

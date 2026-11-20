import { isQuotaLimitError, resolveLimitReset, FALLBACK_RESUME_DELAY_MS } from './quota-limit.js';

// Resumes a session by itself once the usage limit that stopped it lifts.
//
// The state lives on the session record as `metadata.openchamber.autoResume`,
// so it survives a restart and every client reads it from the session:
// `{ enabled, status, resumeAt, resetWindow, prompt, lastError }`.
// `status` is `idle` (nothing pending), `scheduled` (a timer will send the
// prompt at `resumeAt`), `running` (the prompt is being sent) or `failed`
// (sending it failed; `lastError` says why).
//
// A turn that fails on a limit records when the limit lifts even while the
// toggle is off, so the error notice can offer that time. With the toggle on
// it also arms the timer. A prompt the user sends cancels a pending resume.

export const DEFAULT_RESUME_PROMPT = 'Kaldığın yerden devam et.';

// setTimeout fires at once for delays above 2^31-1 ms; longer waits re-arm.
const MAX_TIMER_MS = 2_147_483_647;

const RESTARTED_ERROR = 'The server restarted while the resume prompt was being sent.';

export const readAutoResume = (session) => session?.metadata?.openchamber?.autoResume ?? null;

const withAutoResume = (metadata, autoResume) => ({
  ...(metadata ?? {}),
  openchamber: { ...(metadata?.openchamber ?? {}), autoResume },
});

/**
 * @param {object} options
 * @param {{ getSession: Function, updateSession: Function, listSessions: Function }} options.store
 * @param {(session: object, text: string) => Promise<void>} options.resumeSession sends the prompt to the session
 * @param {(sessionId: string, metadata: object) => void} options.announce tells clients the metadata changed
 * @param {(engineId: string) => Promise<object>} [options.fetchQuota]
 */
export const createAutoResume = ({
  store,
  resumeSession,
  announce,
  fetchQuota = null,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
}) => {
  const pending = new Map();

  const cancelTimer = (sessionId) => {
    const handle = pending.get(sessionId);
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    pending.delete(sessionId);
  };

  const write = async (sessionId, patch) => {
    const session = await store.getSession(sessionId);
    if (!session) return null;
    const next = { enabled: false, status: 'idle', resumeAt: null, resetWindow: null, prompt: null, lastError: null, ...readAutoResume(session), ...patch };
    const metadata = withAutoResume(session.metadata, next);
    await store.updateSession(sessionId, { metadata });
    announce(sessionId, metadata);
    return next;
  };

  const arm = (sessionId, resumeAt) => {
    cancelTimer(sessionId);
    const delay = Math.max(0, resumeAt - now());
    const handle = timers.setTimeout(() => {
      pending.delete(sessionId);
      if (delay > MAX_TIMER_MS) {
        arm(sessionId, resumeAt);
        return;
      }
      void fire(sessionId);
    }, Math.min(delay, MAX_TIMER_MS));
    handle?.unref?.();
    pending.set(sessionId, handle);
  };

  const fire = async (sessionId) => {
    const session = await store.getSession(sessionId);
    const state = readAutoResume(session);
    if (!session || !state?.enabled || state.status !== 'scheduled') return;
    await write(sessionId, { status: 'running', lastError: null });
    try {
      await resumeSession(session, state.prompt || DEFAULT_RESUME_PROMPT);
      // A turn that hit the limit again at once has already rescheduled itself.
      if (readAutoResume(await store.getSession(sessionId))?.status !== 'running') return;
      await write(sessionId, { status: 'idle', resumeAt: null, resetWindow: null });
    } catch (error) {
      await write(sessionId, { status: 'failed', lastError: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Called when a turn ends. A failure that reads as a usage limit records
   * when it lifts and, with the toggle on, schedules the resume.
   */
  const noteTurnEnded = async (sessionId, outcome, error) => {
    if (outcome !== 'failed' || !isQuotaLimitError(error?.message)) return;
    const session = await store.getSession(sessionId);
    if (!session) return;
    const scopedFetchQuota = fetchQuota
      ? (engineId) => fetchQuota(engineId, session.accountId)
      : null;
    const { resetAt, window } = await resolveLimitReset({ message: error.message, engineId: session.engine, fetchQuota: scopedFetchQuota, now: now() });
    const enabled = Boolean(readAutoResume(session)?.enabled);
    await write(sessionId, { resumeAt: resetAt, resetWindow: window, status: enabled ? 'scheduled' : 'idle', lastError: null });
    if (enabled) arm(sessionId, resetAt);
  };

  /** The user sent a prompt: a resume still waiting is no longer needed. */
  const noteUserPrompt = async (sessionId) => {
    if (!pending.has(sessionId)) return;
    cancelTimer(sessionId);
    await write(sessionId, { status: 'idle', resumeAt: null });
  };

  /**
   * Turns the toggle on or off, optionally with a time and a prompt. On
   * without a time keeps the recorded reset when it is still ahead, else
   * waits the fallback 30 minutes.
   */
  const configure = async (sessionId, { enabled, resumeAt, prompt }) => {
    const session = await store.getSession(sessionId);
    if (!session) return null;
    const current = readAutoResume(session);
    const patch = {};
    if (prompt !== undefined) patch.prompt = prompt?.trim() ? prompt.trim() : null;
    if (!enabled) {
      cancelTimer(sessionId);
      return write(sessionId, { ...patch, enabled: false, status: 'idle' });
    }
    const recorded = Number.isFinite(current?.resumeAt) && current.resumeAt > now() ? current.resumeAt : null;
    const at = resumeAt ?? recorded ?? now() + FALLBACK_RESUME_DELAY_MS;
    const next = await write(sessionId, {
      ...patch,
      enabled: true,
      status: 'scheduled',
      resumeAt: at,
      resetWindow: resumeAt ? 'user' : current?.resetWindow ?? null,
      lastError: null,
    });
    arm(sessionId, at);
    return next;
  };

  /** Re-arms every resume a previous server left scheduled. */
  const restore = async () => {
    for (const session of await store.listSessions()) {
      const state = readAutoResume(session);
      if (!state?.enabled) continue;
      if (state.status === 'scheduled' && Number.isFinite(state.resumeAt)) arm(session.id, state.resumeAt);
      // A prompt that may or may not have reached the CLI is not sent twice.
      if (state.status === 'running') await write(session.id, { status: 'failed', lastError: RESTARTED_ERROR });
    }
  };

  const stop = () => {
    for (const sessionId of [...pending.keys()]) cancelTimer(sessionId);
  };

  return { noteTurnEnded, noteUserPrompt, configure, restore, stop, fire, isPending: (sessionId) => pending.has(sessionId) };
};

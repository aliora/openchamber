/**
 * Waits for the end of the turn a scheduled run starts in its session.
 *
 * Sending a prompt only queues the turn: the prompt route answers as soon as
 * the CLI accepted the message, while the turn runs for minutes after. A run
 * is finished when the session's execution ends, which the server's global
 * event hub reports as `session.idle` (succeeded, or `aborted` when it was
 * interrupted) or `session.error` (failed).
 *
 * The watch starts before the prompt is sent, so a turn that ends at once is
 * still seen. When the hub reconnects, an end sent while it was away is lost;
 * the watch then asks the server whether the session still runs and, when it
 * does not, reads the outcome from the session's last assistant message.
 */
export const watchTurnEnd = ({ globalEventHub, sessionID, readSettledOutcome, signal, logger = console }) => {
  let settled = false;
  let resolveEnd;
  let rejectEnd;
  const ended = new Promise((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });
  // The turn can fail while the prompt is still being sent, before anyone
  // awaits `ended`; that must not surface as an unhandled rejection.
  ended.catch(() => {});

  const unsubscribers = [];
  const stop = () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
  const succeed = () => {
    if (settled) return;
    settled = true;
    stop();
    resolveEnd();
  };
  const fail = (message) => {
    if (settled) return;
    settled = true;
    stop();
    rejectEnd(new Error(message));
  };

  const handlePayload = (payload) => {
    if (payload?.properties?.sessionID !== sessionID) return;
    if (payload.type === 'session.error') {
      fail(payload.properties.error?.message || 'the session turn failed');
      return;
    }
    if (payload.type !== 'session.idle') return;
    if (payload.properties.aborted === true) {
      fail(`the session turn was interrupted (${payload.properties.reason || 'user'})`);
      return;
    }
    succeed();
  };

  const checkAfterReconnect = async () => {
    try {
      const outcome = await readSettledOutcome(sessionID);
      if (outcome === null) return;
      if (outcome.ok) succeed();
      else fail(outcome.error);
    } catch (error) {
      logger.warn?.('[ScheduledTasks] could not read the turn outcome after the event stream reconnected', {
        sessionID,
        error: error?.message ?? String(error),
      });
    }
  };

  if (signal) {
    const onAbort = () => fail('the run stopped waiting for the session turn');
    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribers.push(() => signal.removeEventListener('abort', onAbort));
  }
  unsubscribers.push(globalEventHub.subscribeEvent((event) => {
    for (const payload of event?.translated?.() ?? []) handlePayload(payload);
  }));
  unsubscribers.push(globalEventHub.subscribeStatus((status) => {
    if (status?.type === 'connect') void checkAfterReconnect();
  }));

  return { ended, stop };
};

/**
 * The outcome of a session's finished turn, read from the server: `null`
 * while the session still runs, otherwise whether its last assistant message
 * ended without an error.
 */
export const createSettledOutcomeReader = ({ baseUrl, authHeaders }) => async (sessionID) => {
  const read = async (path) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  };

  const active = await read('/api/session/active');
  if (active?.data?.[sessionID]) return null;

  const history = await read(`/api/session/${encodeURIComponent(sessionID)}/message?type=assistant&order=desc&limit=1`);
  const lastAssistant = Array.isArray(history?.data) ? history.data[0] : undefined;
  if (!lastAssistant) throw new Error('the session has no answer to read an outcome from');
  if (lastAssistant.error) return { ok: false, error: lastAssistant.error.message || 'the session turn failed' };
  return { ok: true };
};

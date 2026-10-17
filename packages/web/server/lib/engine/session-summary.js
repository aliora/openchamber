// The compact list of this server's sessions with their live state, for an
// OpenChamber window that watches this server while it is connected to another
// one (the multi-host sidebar). It carries no message content: a row is the
// title, where the session works, its engine and what it is doing now.
//
// State comes from the owners of each fact, read when a row is built:
// - `waiting-permission`: the control bridge holds an unanswered request;
// - `running`: the session runtime has a prompt queued or being answered;
// - `failed`: the last finished turn failed and no new one started;
// - `idle`: anything else. `outcome` names the last finished turn when the
//   runtime saw one since the server started.
// `waiting-input` belongs to the contract for engines that ask questions; no
// engine does yet, so no row carries it.
// `chat` marks a session of the managed Chats, whose folder is inside one of
// `chatRoots`, so a watching window lists it under Chats and not as a folder of
// its own.
//
// The stream starts with a full snapshot, then sends one row each time a
// session's state, pending request or title changes, and `removed` for a
// deleted session. A comment line every `heartbeatMs` lets the client tell a
// quiet stream from a dead one.

const DEFAULT_HEARTBEAT_MS = 15_000;

const stateOf = ({ runtime, controlBridge }, sessionId, outcome) => {
  if (controlBridge.getPendingRequests(sessionId).length > 0) return 'waiting-permission';
  if (runtime.isTurnActive(sessionId)) return 'running';
  if (outcome === 'failed') return 'failed';
  return 'idle';
};

const toSlashPath = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '');

export const createSessionSummary = ({ store, registry, runtime, controlBridge, chatRoots = [] }) => {
  const roots = chatRoots.filter(Boolean).map(toSlashPath);
  const isChatDirectory = (directory) => {
    const normalized = toSlashPath(directory);
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  const listeners = new Set();
  // The last row sent for each session, so a notification that changed nothing
  // the row shows sends nothing.
  const lastSent = new Map();

  /** The row for a stored session, or null when its engine is not registered (it is not listed either). */
  const describe = (session) => {
    const adapter = registry.forSession(session);
    if (!adapter) return null;
    const outcome = runtime.lastOutcome(session.id);
    const row = {
      id: session.id,
      title: String(session.title || ''),
      directory: session.cwd || process.cwd(),
      engine: adapter.id,
      updatedAt: Number(session.updatedAt || session.createdAt || 0),
      state: stateOf({ runtime, controlBridge }, session.id, outcome),
    };
    if (session.parentID) row.parentID = String(session.parentID);
    if (outcome) row.outcome = outcome;
    if (isChatDirectory(row.directory)) row.chat = true;
    return row;
  };

  const emit = (event) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const list = async () => (await store.listSessions()).flatMap((session) => {
    const row = describe(session);
    return row ? [row] : [];
  });

  const remove = (sessionId) => {
    lastSent.delete(sessionId);
    emit({ type: 'removed', id: sessionId });
  };

  /** Sends the session's current row when it differs from the last one sent. */
  const publish = async (sessionId) => {
    const session = await store.getSession(sessionId);
    const row = session ? describe(session) : null;
    if (!row) {
      remove(sessionId);
      return;
    }
    const key = JSON.stringify(row);
    if (lastSent.get(sessionId) === key) return;
    lastSent.set(sessionId, key);
    emit({ type: 'session', session: row });
  };

  const publishQuietly = (sessionId) => {
    publish(sessionId).catch((error) => {
      console.warn('[engine] Failed to publish session summary:', error.message);
    });
  };
  runtime.subscribeActivity(publishQuietly);
  controlBridge.subscribe(publishQuietly);

  return {
    list,
    publish: publishQuietly,
    remove,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const writeEvent = (res, event) => {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

/**
 * Serves the summary stream on one response. Changes that land while the
 * snapshot is read wait until it is sent, so the client never sees a row
 * before the snapshot it belongs to.
 */
export const streamSessionSummary = async (summary, res, { heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) => {
  let snapshotSent = false;
  let closed = false;
  let heartbeat = null;
  const waiting = [];
  const unsubscribe = summary.subscribe((event) => {
    if (snapshotSent) writeEvent(res, event);
    else waiting.push(event);
  });
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });

  let sessions;
  try {
    sessions = await summary.list();
  } catch (error) {
    unsubscribe();
    res.status(500).json({ error: error.message });
    return;
  }
  if (closed) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  writeEvent(res, { type: 'snapshot', sessions });
  snapshotSent = true;
  for (const event of waiting.splice(0)) {
    writeEvent(res, event);
  }

  heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, heartbeatMs);
};

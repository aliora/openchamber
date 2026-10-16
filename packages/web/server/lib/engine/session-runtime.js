import crypto from 'node:crypto';
import { createTurnTranslator } from './turn-translator.js';
import { toPermissionRequest } from './permission-request.js';

// Owns the live CLI process of each session and the queue of prompts it is
// answering. The process is engine-specific; everything here is shared.
//
// A CLI answers prompts in the order it received them, so events always belong
// to the oldest unfinished turn. A process that exits or fails mid-turn ends
// every queued turn as failed, and partial output is still persisted.

export class EngineSessionRuntime {
  constructor({ store, streamHub, controlBridge }) {
    this.store = store;
    this.streamHub = streamHub;
    this.controlBridge = controlBridge;
    this.live = new Map();
    // Outcome of each session's last finished turn. Memory only: after a
    // restart every session reads as idle with no outcome.
    this.outcomes = new Map();
    this.activityListeners = new Set();
  }

  isRunning(sessionId) {
    return this.live.has(sessionId);
  }

  /** True while the session has a prompt queued or being answered. A live process alone is not a turn. */
  isTurnActive(sessionId) {
    return (this.live.get(sessionId)?.turns.length ?? 0) > 0;
  }

  /** `succeeded`, `failed` or `interrupted` for the session's last finished turn, or null. */
  lastOutcome(sessionId) {
    return this.outcomes.get(sessionId) ?? null;
  }

  /** Calls `listener(sessionId)` after a turn starts or ends. Returns the unsubscribe function. */
  subscribeActivity(listener) {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  notifyActivity(sessionId) {
    for (const listener of this.activityListeners) {
      listener(sessionId);
    }
  }

  /** Drops what the runtime remembers about a deleted session. */
  forget(sessionId) {
    this.outcomes.delete(sessionId);
  }

  recordOutcome(sessionId, outcome) {
    this.outcomes.set(sessionId, outcome);
    this.notifyActivity(sessionId);
  }

  runningSessionIds() {
    return [...this.live.keys()];
  }

  broadcast(sessionId, event) {
    this.streamHub.broadcast(sessionId, event);
  }

  async prompt({ session, adapter, text, model, effort, permissionMode }) {
    const sessionId = session.id;
    const userMessageID = `msg_${crypto.randomUUID()}`;
    const assistantMessageID = `msg_${crypto.randomUUID()}`;

    await this.store.appendMessage(sessionId, {
      id: userMessageID,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      parts: [{ id: `${userMessageID}_p0`, type: 'text', text }],
    });
    this.broadcast(sessionId, {
      type: 'session.inbox.enqueued',
      created: Date.now(),
      data: { sessionID: sessionId, inboxID: userMessageID, item: { type: 'user', payload: { text } } },
    });
    this.broadcast(sessionId, { type: 'session.execution.started', created: Date.now(), data: { sessionID: sessionId } });

    const entry = await this.ensureProcess({ session, adapter, model, effort, permissionMode });
    const turn = createTurnTranslator({
      sessionId,
      assistantMessageID,
      agent: adapter.id,
      providerID: adapter.providerID,
      modelID: model,
      broadcast: (event) => this.broadcast(sessionId, event),
    });
    entry.turns.push(turn);
    this.notifyActivity(sessionId);
    if (entry.turns.length === 1) turn.begin();

    try {
      entry.process.sendUserMessage(text);
    } catch (error) {
      await this.endSession(entry, 'failed');
      throw error;
    }
    return { assistantMessageID };
  }

  async ensureProcess({ session, adapter, model, effort, permissionMode }) {
    const existing = this.live.get(session.id);
    if (existing && existing.process.isAlive) return existing;

    const process = adapter.createProcess({
      sessionId: session.id,
      cwd: session.cwd,
      model,
      effort,
      permissionMode,
      resume: true,
    });
    const entry = { sessionId: session.id, adapter, process, permissionMode, turns: [], ended: false };
    this.live.set(session.id, entry);

    for (const eventName of ['reasoning.delta', 'text.delta', 'tool.started']) {
      process.on(eventName, (payload) => entry.turns[0]?.handle(eventName, payload));
    }
    process.on('permission.requested', (request) => {
      void this.handlePermission(entry, request);
    });
    process.on('turn.completed', (result) => {
      void this.completeTurn(entry, result);
    });
    process.on('error', () => {
      void this.endSession(entry, 'failed');
    });
    process.on('exit', () => {
      void this.endSession(entry, 'failed');
    });

    try {
      await process.start();
    } catch (error) {
      await this.endSession(entry, 'failed');
      throw error;
    }
    return entry;
  }

  async handlePermission(entry, request) {
    this.broadcast(entry.sessionId, {
      type: 'permission.asked',
      created: Date.now(),
      data: toPermissionRequest(entry.sessionId, request),
    });
    const decision = await this.controlBridge.handleControlRequest(entry.sessionId, request, entry.permissionMode);
    if (entry.ended || !entry.process.isAlive) return;
    entry.process.respondPermission(request.requestId, decision.behavior);
  }

  async completeTurn(entry, { outcome, usage }) {
    const turn = entry.turns.shift();
    if (!turn) return;
    this.recordOutcome(entry.sessionId, outcome);
    await this.persist(entry.sessionId, turn.finish({ outcome, usage }));

    const next = entry.turns[0];
    if (next) {
      next.begin();
      return;
    }
    this.broadcast(entry.sessionId, {
      type: 'session.idle',
      created: Date.now(),
      data: { sessionID: entry.sessionId, outcome },
    });
  }

  /** Ends every queued turn with one outcome and forgets the process. Safe to call twice. */
  async endSession(entry, outcome) {
    if (entry.ended) return;
    entry.ended = true;
    if (this.live.get(entry.sessionId) === entry) this.live.delete(entry.sessionId);
    this.controlBridge.clearSession(entry.sessionId);

    const pending = entry.turns.splice(0);
    if (pending.length > 0) this.recordOutcome(entry.sessionId, outcome);
    for (const turn of pending) {
      await this.persist(entry.sessionId, turn.finish({ outcome }));
    }
    if (pending.length > 0) {
      this.broadcast(entry.sessionId, {
        type: 'session.idle',
        created: Date.now(),
        data: { sessionID: entry.sessionId, outcome },
      });
    }
  }

  async persist(sessionId, message) {
    if (!message) return;
    try {
      await this.store.appendMessage(sessionId, message);
    } catch (error) {
      console.error('[engine] Failed to persist assistant message:', error.message);
    }
  }

  /** Stops the session's CLI. Queued turns end as interrupted. */
  async abort(sessionId) {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    const ending = this.endSession(entry, 'interrupted');
    await entry.process.abort();
    await ending;
    return true;
  }
}

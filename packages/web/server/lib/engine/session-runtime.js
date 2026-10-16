import crypto from 'node:crypto';
import { createTurnTranslator } from './turn-translator.js';
import { toPermissionRequest } from './permission-request.js';

// Owns the live CLI process of each session and the queue of prompts it is
// answering. The process is engine-specific; everything here is shared.
//
// A CLI answers prompts in the order it received them, so events always belong
// to the oldest unfinished turn. A process that exits or fails mid-turn ends
// every queued turn as failed, and partial output is still persisted.
//
// The session's live status follows OpenCode 2.x execution events: one
// `session.execution.started` when a prompt is accepted, and exactly one of
// `succeeded`, `failed` or `interrupted` once the queue drains. The UI and the
// host's status map read only these, so every path that ends a turn sends one.

export const executionEvent = (sessionId, outcome, error) => {
  const data = { sessionID: sessionId };
  if (outcome === 'failed') data.error = error;
  // `user` is the one reason this runtime knows: the abort route.
  if (outcome === 'interrupted') data.reason = 'user';
  return { type: `session.execution.${outcome}`, created: Date.now(), data };
};

const engineError = (type, message) => ({ type, message });

export class EngineSessionRuntime {
  constructor({ store, streamHub, controlBridge }) {
    this.store = store;
    this.streamHub = streamHub;
    this.controlBridge = controlBridge;
    this.live = new Map();
  }

  /**
   * Sessions with a turn still open. A CLI process outlives its turns so the
   * next prompt resumes it, so a live process alone does not mean running.
   */
  runningSessionIds() {
    return [...this.live.values()].filter((entry) => entry.turns.length > 0).map((entry) => entry.sessionId);
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

    let entry;
    try {
      entry = await this.ensureProcess({ session, adapter, model, effort, permissionMode });
    } catch (error) {
      // No turn was queued yet, so nothing else would end the execution
      // the UI was just told about.
      this.broadcast(sessionId, executionEvent(sessionId, 'failed', engineError('EngineStartFailed', error.message || `${adapter.displayName} could not start.`)));
      throw error;
    }
    const turn = createTurnTranslator({
      sessionId,
      assistantMessageID,
      agent: adapter.id,
      providerID: adapter.providerID,
      modelID: model,
      broadcast: (event) => this.broadcast(sessionId, event),
    });
    entry.turns.push(turn);
    if (entry.turns.length === 1) turn.begin();

    try {
      entry.process.sendUserMessage(text);
    } catch (error) {
      await this.endSession(entry, 'failed', engineError('EngineSendFailed', error.message || `${adapter.displayName} did not accept the prompt.`));
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
    process.on('error', (error) => {
      void this.endSession(entry, 'failed', engineError('EngineProcessError', error?.message || `${adapter.displayName} failed.`));
    });
    process.on('exit', () => {
      void this.endSession(entry, 'failed', engineError('EngineExited', `${adapter.displayName} stopped before the turn finished.`));
    });

    try {
      await process.start();
    } catch (error) {
      await this.endSession(entry, 'failed', engineError('EngineStartFailed', error.message || `${adapter.displayName} could not start.`));
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

  async completeTurn(entry, { outcome, usage, error }) {
    const turn = entry.turns.shift();
    if (!turn) return;
    await this.persist(entry.sessionId, turn.finish({ outcome, usage }));

    const next = entry.turns[0];
    if (next) {
      next.begin();
      return;
    }
    this.broadcast(entry.sessionId, executionEvent(
      entry.sessionId,
      outcome,
      error ?? engineError('EngineTurnFailed', `${entry.adapter.displayName} ended the turn with an error.`),
    ));
  }

  /**
   * Ends every queued turn with one outcome and forgets the process. Safe to
   * call twice. `error` describes a failure; other outcomes ignore it.
   */
  async endSession(entry, outcome, error = engineError('EngineFailed', `${entry.adapter.displayName} failed.`)) {
    if (entry.ended) return;
    entry.ended = true;
    if (this.live.get(entry.sessionId) === entry) this.live.delete(entry.sessionId);
    this.controlBridge.clearSession(entry.sessionId);

    const pending = entry.turns.splice(0);
    for (const turn of pending) {
      await this.persist(entry.sessionId, turn.finish({ outcome }));
    }
    if (pending.length > 0) {
      this.broadcast(entry.sessionId, executionEvent(entry.sessionId, outcome, error));
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

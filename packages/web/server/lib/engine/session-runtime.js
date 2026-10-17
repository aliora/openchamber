import crypto from 'node:crypto';
import { createTurnTranslator } from './turn-translator.js';
import { toPermissionRequest } from './permission-request.js';
import { buildHandoffPrompt } from './handoff.js';

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
//
// `toolServer` is optional and injected (DOCUMENTATION.md, *Tool server*):
// each process gets its own grant to OpenChamber's tools, revoked when the
// process ends. This module never sees how the tools are served.

const TURN_EVENTS = ['reasoning.delta', 'text.delta', 'tool.started', 'tool.called', 'tool.completed'];

export const executionEvent = (sessionId, outcome, error) => {
  const data = { sessionID: sessionId };
  if (outcome === 'failed') data.error = error;
  // `user` is the one reason this runtime knows: the abort route.
  if (outcome === 'interrupted') data.reason = 'user';
  return { type: `session.execution.${outcome}`, created: Date.now(), data };
};

const engineError = (type, message) => ({ type, message });

const ID_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTime = 0;
let idCounter = 0;

/**
 * A message id in OpenCode's ascending format, the one the UI mints for the
 * prompts it sends (`ascendingId` in packages/ui/src/lib/opencode/ids.ts):
 * `msg_`, 12 hex digits of the time and a counter, 14 random characters. The
 * chat orders messages by creation time and a tie by id, so an answer whose
 * turn began in the millisecond its prompt was stored still sorts after it.
 */
const ascendingMessageId = () => {
  const now = Date.now();
  if (now !== lastIdTime) {
    lastIdTime = now;
    idCounter = 0;
  }
  idCounter += 1;
  const sortable = (BigInt(now) * 0x1000n + BigInt(idCounter)).toString(16).padStart(12, '0').slice(-12);
  const random = [...crypto.randomBytes(14)].map((byte) => ID_CHARACTERS[byte % ID_CHARACTERS.length]).join('');
  return `msg_${sortable}${random}`;
};

export class EngineSessionRuntime {
  constructor({ store, streamHub, controlBridge, toolServer = null }) {
    this.store = store;
    this.streamHub = streamHub;
    this.controlBridge = controlBridge;
    this.toolServer = toolServer;
    this.live = new Map();
    // Outcome of each session's last finished turn. Memory only: after a
    // restart every session reads as idle with no outcome.
    this.outcomes = new Map();
    this.activityListeners = new Set();
  }

  /**
   * A grant for one process, or null when there is no tool server or it
   * cannot serve now. The session still runs, only without OpenChamber's
   * tools, and the log says why (never the token).
   */
  grantTools(session) {
    if (!this.toolServer) return null;
    try {
      return this.toolServer.grant({ sessionId: session.id, directory: session.cwd });
    } catch (error) {
      console.warn(`[engine] OpenChamber tools are unavailable for session ${session.id}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async toolInstructionsFor(toolGrant) {
    if (!toolGrant) return undefined;
    try {
      return (await this.toolServer.instructions?.()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  describeToolResult(name, output) {
    return this.toolServer?.describeResult(name, output);
  }

  /** Whether the session has a live CLI process, between turns included. */
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

  /**
   * Sessions with a turn still open. A CLI process outlives its turns so the
   * next prompt resumes it, so a live process alone does not mean running.
   */
  runningSessionIds() {
    return [...this.live.values()].filter((entry) => entry.turns.length > 0).map((entry) => entry.sessionId);
  }

  /**
   * The assistant messages of the session's turns that began and have not
   * ended, in the stored format. A turn's message is stored the moment it
   * ends, so a history read sees each message once: here or in the store.
   */
  openMessages(sessionId) {
    const entry = this.live.get(sessionId);
    if (!entry) return [];
    return entry.turns.flatMap((turn) => turn.snapshot() ?? []);
  }

  broadcast(sessionId, event) {
    this.streamHub.broadcast(sessionId, event);
  }

  /**
   * `messageID` is the id the client minted for the prompt, if any. The user
   * message keeps it, so the client's optimistic copy of the prompt is the
   * stored one, live and after a reload.
   */
  admitSynthetic(sessionId, { id, text, description, metadata }) {
    const item = { id: id ?? ascendingMessageId(), text, description, metadata, createdAt: Date.now() };
    this.broadcast(sessionId, {
      type: 'session.inbox.enqueued',
      created: item.createdAt,
      data: { sessionID: sessionId, inboxID: item.id, item: { type: 'synthetic', payload: { text, description, metadata } } },
    });
    return item;
  }

  async prompt({ session, adapter, text, context = [], model, effort, permissionMode, messageID }) {
    const sessionId = session.id;
    const userMessageID = messageID ?? ascendingMessageId();
    const assistantMessageID = ascendingMessageId();

    const createdAt = Date.now();
    await this.store.appendMessage(sessionId, {
      id: userMessageID,
      role: 'user',
      content: text,
      createdAt,
      parts: [{ id: `${userMessageID}_p0`, type: 'text', text }],
      ...(context.length > 0 ? { context } : {}),
    });
    this.broadcast(sessionId, {
      type: 'session.inbox.enqueued',
      created: createdAt,
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
      describeToolResult: (name, output) => this.describeToolResult(name, output),
    });
    entry.turns.push(turn);
    this.notifyActivity(sessionId);
    if (entry.turns.length === 1) turn.begin();

    try {
      const promptText = [...context.map((item) => item.text), text].join('\n\n');
      entry.process.sendUserMessage(await this.textForProcess(entry, userMessageID, promptText));
    } catch (error) {
      await this.endSession(entry, 'failed', engineError('EngineSendFailed', error.message || `${adapter.displayName} did not accept the prompt.`));
      throw error;
    }
    // A call that waits for the user (a page asking for an answer) would hold
    // this message behind it until answered; the tool server ends the wait so
    // the agent reads the message instead.
    entry.toolGrant?.noteUserMessage();
    return { assistantMessageID };
  }

  async ensureProcess({ session, adapter, model, effort, permissionMode }) {
    const existing = this.live.get(session.id);
    if (existing && existing.process.isAlive) {
      // A CLI reads its model, effort and permission mode when it starts. A
      // live process between turns that runs on other settings than this
      // prompt asks for is replaced by one that resumes the conversation; one
      // still answering a turn keeps them until the queue drains.
      const sameSettings = existing.adapter === adapter
        && existing.model === model
        && existing.effort === effort
        && existing.permissionMode === permissionMode;
      if (sameSettings || existing.turns.length > 0) return existing;
      await this.retire(existing);
    }

    const toolGrant = this.grantTools(session);
    const toolInstructions = await this.toolInstructionsFor(toolGrant);
    const handoff = Boolean(session.handoff);
    const resume = !handoff && await this.hasAnsweredTurn(session.id);
    let process;
    try {
      process = adapter.createProcess({
        sessionId: session.id,
        cwd: session.cwd,
        model,
        effort,
        permissionMode,
        resume,
        engineState: session.engineState ?? null,
        handoff,
        toolServer: toolGrant?.server,
        toolInstructions,
      });
    } catch (error) {
      toolGrant?.revoke();
      throw error;
    }
    const entry = { sessionId: session.id, adapter, process, model, effort, permissionMode, toolGrant, handoff, turns: [], ended: false };
    this.live.set(session.id, entry);

    for (const eventName of TURN_EVENTS) {
      process.on(eventName, (payload) => entry.turns[0]?.handle(eventName, payload));
    }
    // The CLI answers the next queued prompt inside the running turn, so that
    // prompt gets no turn of its own: one waiting for a result that never
    // comes would keep the session busy and shift every later answer.
    process.on('prompt.merged', () => {
      entry.turns.splice(1, 1);
    });
    process.on('engine.state', (engineState) => {
      void this.saveEngineState(session.id, engineState);
    });
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
    this.recordOutcome(entry.sessionId, outcome);
    await this.persist(entry.sessionId, turn.finish({ outcome, usage, error }));

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
    // The token dies with the process, and calls it still runs are aborted.
    entry.toolGrant?.revoke();
    this.controlBridge.clearSession(entry.sessionId);

    const pending = entry.turns.splice(0);
    if (pending.length > 0) this.recordOutcome(entry.sessionId, outcome);
    for (const turn of pending) {
      await this.persist(entry.sessionId, turn.finish({ outcome, error }));
    }
    if (pending.length > 0) {
      this.broadcast(entry.sessionId, executionEvent(entry.sessionId, outcome, error));
    }
  }

  async textForProcess(entry, userMessageID, text) {
    if (!entry.handoff) return text;
    entry.handoff = false;
    const history = await this.store.getMessages(entry.sessionId);
    return buildHandoffPrompt(history.filter((message) => message.id !== userMessageID), text);
  }

  /** Whether an earlier turn of the session got an answer, so the CLI has a conversation to continue. */
  async hasAnsweredTurn(sessionId) {
    const messages = await this.store.getMessages(sessionId);
    return messages.some((message) => message.role === 'assistant');
  }

  /** Keeps what the CLI needs to resume this session in a later process, such as its own conversation id. */
  async saveEngineState(sessionId, engineState) {
    try {
      await this.store.updateSession(sessionId, { engineState, handoff: undefined });
    } catch (error) {
      console.error('[engine] Failed to store engine state:', error.message);
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

  /**
   * Hands a new permission mode to the session's live CLI. Resolves `now`
   * when the running process took it (or already runs on it), and
   * `next-message` when it reaches the CLI with the next prompt instead: no
   * process is running, the engine cannot switch a running process to this
   * mode, or the CLI refused. `ensureProcess` then replaces the idle process,
   * because its mode differs from the session's.
   */
  async applyPermissionMode(sessionId, mode) {
    const entry = this.live.get(sessionId);
    if (!entry || !entry.process.isAlive) return 'next-message';
    if (entry.permissionMode === mode) return 'now';
    const live = entry.adapter.livePermissionModes ?? [];
    if (!live.includes(mode) || !(entry.process.setPermissionMode instanceof Function)) return 'next-message';
    try {
      await entry.process.setPermissionMode(mode);
    } catch (error) {
      console.warn(`[engine] ${entry.adapter.displayName} kept its permission mode for session ${sessionId} until its next prompt:`, error instanceof Error ? error.message : String(error));
      return 'next-message';
    }
    if (entry.ended) return 'next-message';
    entry.permissionMode = mode;
    return 'now';
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

  /** Stops an idle process quietly: it has no turn, so nothing is announced. */
  async retire(entry) {
    const ending = this.endSession(entry, 'interrupted');
    await entry.process.abort();
    await ending;
  }
}

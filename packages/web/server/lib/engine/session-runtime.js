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
// `toolServer` is optional and injected (DOCUMENTATION.md, *Tool server*):
// each process gets its own grant to OpenChamber's tools, revoked when the
// process ends. This module never sees how the tools are served.

const TURN_EVENTS = ['reasoning.delta', 'text.delta', 'tool.started', 'tool.called', 'tool.completed'];

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

  describeToolResult(name, output) {
    return this.toolServer?.describeResult(name, output);
  }

  isRunning(sessionId) {
    return this.live.has(sessionId);
  }

  runningSessionIds() {
    return [...this.live.keys()];
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
  async prompt({ session, adapter, text, model, effort, permissionMode, messageID }) {
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
    });
    this.broadcast(sessionId, {
      type: 'session.inbox.enqueued',
      created: createdAt,
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
      describeToolResult: (name, output) => this.describeToolResult(name, output),
    });
    entry.turns.push(turn);
    if (entry.turns.length === 1) turn.begin();

    try {
      entry.process.sendUserMessage(text);
    } catch (error) {
      await this.endSession(entry, 'failed');
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
    if (existing && existing.process.isAlive) return existing;

    const toolGrant = this.grantTools(session);
    let process;
    try {
      process = adapter.createProcess({
        sessionId: session.id,
        cwd: session.cwd,
        model,
        effort,
        permissionMode,
        resume: true,
        engineState: session.engineState ?? null,
        toolServer: toolGrant?.server,
      });
    } catch (error) {
      toolGrant?.revoke();
      throw error;
    }
    const entry = { sessionId: session.id, adapter, process, permissionMode, toolGrant, turns: [], ended: false };
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
    // The token dies with the process, and calls it still runs are aborted.
    entry.toolGrant?.revoke();
    this.controlBridge.clearSession(entry.sessionId);

    const pending = entry.turns.splice(0);
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

  /** Keeps what the CLI needs to resume this session in a later process, such as its own conversation id. */
  async saveEngineState(sessionId, engineState) {
    try {
      await this.store.updateSession(sessionId, { engineState });
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

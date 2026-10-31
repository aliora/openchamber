// Results of sessions an agent dispatched and asked to hear back from.
//
// An agent that creates, sends to, or forks a session with `returnResult`
// gets its answer at once and goes on. When the dispatched session's turn is
// over, this runtime hands its final answer to the session that dispatched it
// as a synthetic message and wakes that session, so the agent continues on its
// own: background primary sessions, the way OpenCode 2 reports a background
// subagent to its parent (core `session/subagent-completion.ts`).
//
// Event-driven like the message queue: the shared upstream hub delivers
// `session.status`, and an idle transition of a watched session arms a short
// timer. The tick confirms the turn is over against OpenCode itself (not
// running, no running subagent, and the `idle` record OpenCode appends when a
// run ends) before anything is delivered. Pending deliveries are persisted,
// so a restart in between still delivers.

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

const FILE_NAME = 'dispatch-results.json';
const FILE_VERSION = 1;
const MAX_ENTRIES = 200;
// Idle events arrive in bursts around a turn boundary.
const QUIET_MS = 500;
// While a subagent of the dispatched session runs, the turn is not over yet.
const SUBAGENT_RECHECK_MS = 5_000;
// An idle session without the run's `idle` record yet: the record lands with
// the event, so a few short rechecks cover a projection that trails it.
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
// The answer travels into the parent's context; a session that wrote a book
// is cut, and the agent can read the rest with session.messages.
const ANSWER_CHAR_LIMIT = 50_000;
const UPDATE_INTERVAL_MS = 120_000;
const UPDATE_CHAR_LIMIT = 400;
const MODEL_NAMES_TTL_MS = 300_000;

const DISPATCH_RESULT_SOURCE = 'openchamber-session';
const DISPATCH_UPDATE_SOURCE = 'openchamber-session-update';

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Boundary schemas: the only place raw JSON (the file, OpenCode answers, hub
// events) is inspected. Everything below branches on what they return.
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/);
const timeSchema = z.number().finite().nonnegative();

const afterIdleSchema = z.string().min(1).nullable();

const entrySchema = z.object({
  id: z.string().min(1),
  parentSessionId: sessionIdSchema,
  sessionId: sessionIdSchema,
  dispatchedAt: timeSchema,
  // The newest end-of-run record before the dispatch; null when there was
  // none. Entries written before this field compare clock times instead.
  afterIdleId: afterIdleSchema.optional(),
  messageId: messageIdSchema.optional(),
});

const storedFileSchema = z.object({ entries: z.array(z.unknown()) });

const idleRecordSchema = z.object({
  id: z.string().min(1),
  type: z.literal('idle'),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']),
  time: z.object({ created: timeSchema }),
});

const assistantRecordSchema = z.object({
  type: z.literal('assistant'),
  content: z.array(z.unknown()).default([]),
  error: z.object({ message: z.string().optional() }).nullish(),
  time: z.object({ created: timeSchema }),
});

const textContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const recordTypeSchema = z.object({ type: z.string() });
const recordIdSchema = z.object({ id: z.string() });
const modelRefSchema = z.object({ providerID: z.string().min(1), id: z.string().min(1) });
const sessionRecordSchema = z.object({ title: z.string().optional(), model: modelRefSchema.optional().catch(undefined) });
const messagePageSchema = z.object({ data: z.array(z.unknown()) });
const modelListSchema = z.array(z.object({ providerID: z.string(), id: z.string(), name: z.string() }).nullable().catch(null));
const providerListSchema = z.array(z.object({ id: z.string(), name: z.string() }).nullable().catch(null));

const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});

const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

const formEventSchema = z.object({
  type: z.literal('form.created'),
  properties: z.object({
    sessionID: z.string().min(1),
    form: z.object({
      title: z.string().optional(),
      fields: z.array(z.object({ title: z.string().optional() }).nullable().catch(null)).catch([]),
    }),
  }),
});

const permissionEventSchema = z.object({
  type: z.literal('permission.asked'),
  properties: z.object({
    sessionID: z.string().min(1),
    action: z.string().optional(),
    message: z.string().optional(),
  }),
});

const backgroundEventSchema = z.object({
  type: z.literal('session.background.waiting'),
  properties: z.object({
    sessionID: z.string().min(1),
    tasks: z.array(z.object({ description: z.string().catch('') }).nullable().catch(null)).catch([]),
  }),
});

const errorCodeSchema = z.object({ code: z.string() });

const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const httpError = (message, status) => Object.assign(new Error(message), { status });

/**
 * A message id in OpenCode's own ascending format (`msg_` + time + random),
 * minted once per delivery and persisted before the first attempt. OpenCode
 * refuses a second admission of the same id, so a retry after a crash or a
 * lost response can never deliver the answer twice.
 */
export const createMessageId = (now) => {
  const time = (BigInt(now) * 0x1000n + BigInt(Math.floor(Math.random() * 0x1000))).toString(16).padStart(12, '0').slice(-12);
  let random = '';
  for (let index = 0; index < 14; index += 1) random += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `msg_${time}${random}`;
};

export const escapeAttribute = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const assistantText = (assistant) => assistant.content
  .map((item) => parse(textContentSchema, item)?.text ?? '')
  .join('')
  .trim();

const OUTCOME_STATES = { succeeded: 'completed', failed: 'error', interrupted: 'cancelled' };

/**
 * How the dispatched turn ended, read from the newest page of the session's
 * records (newest first), or null while it has not ended since the dispatch.
 *
 * OpenCode appends an `idle` record with the run's outcome when a run ends,
 * so the outcome is authoritative and survives a restart of either server.
 * The answer is the newest assistant reply of that turn.
 *
 * "Since the dispatch" is decided by record order against `afterIdleId`, the
 * newest idle record before the prompt went out, so OpenChamber's clock never
 * meets OpenCode's: a remote OpenCode whose clock lags would otherwise make a
 * finished turn look older than its own dispatch. Only an entry stored
 * without that baseline (`afterIdleId` undefined) falls back to `dispatchedAt`.
 */
export const readDispatchOutcome = (records, dispatchedAt, afterIdleId) => {
  const idleIndex = records.findIndex((record) => parse(recordTypeSchema, record)?.type === 'idle');
  if (idleIndex === -1) return null;
  // A malformed idle record proves nothing about the turn: keep waiting.
  const idle = parse(idleRecordSchema, records[idleIndex]);
  if (!idle) return null;
  const byOrder = afterIdleId !== undefined;
  if (byOrder ? idle.id === afterIdleId : idle.time.created < dispatchedAt) return null;
  // The turn's records sit between its idle record and the baseline one.
  const baselineIndex = byOrder && afterIdleId !== null
    ? records.findIndex((record) => parse(recordIdSchema, record)?.id === afterIdleId)
    : -1;
  const turnRecords = records.slice(idleIndex + 1, baselineIndex === -1 ? undefined : baselineIndex);
  const reply = turnRecords
    .map((record) => parse(assistantRecordSchema, record))
    .find((assistant) => assistant !== null && (byOrder || assistant.time.created >= dispatchedAt));
  return {
    idleId: idle.id,
    state: OUTCOME_STATES[idle.outcome],
    text: reply ? assistantText(reply) : '',
    errorMessage: reply?.error?.message?.trim() ?? '',
  };
};

export const latestAssistantSummary = (records) => {
  for (const record of records) {
    const assistant = parse(assistantRecordSchema, record);
    if (!assistant) continue;
    const texts = assistant.content.map((item) => parse(textContentSchema, item)?.text.trim() ?? '').filter(Boolean);
    const paragraph = texts.at(-1)?.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).at(-1);
    if (!paragraph) continue;
    return paragraph.length > UPDATE_CHAR_LIMIT ? `…${paragraph.slice(-UPDATE_CHAR_LIMIT)}` : paragraph;
  }
  return '';
};

const outcomeBody = ({ state, text, errorMessage }, sessionId) => {
  const answer = text.length > ANSWER_CHAR_LIMIT
    ? `${text.slice(0, ANSWER_CHAR_LIMIT)}\n\n[Cut at ${ANSWER_CHAR_LIMIT} characters; read the rest with session.messages for ${sessionId}.]`
    : text;
  if (state === 'completed') return answer || 'The session finished without a text reply.';
  if (state === 'error') {
    const failure = errorMessage ? `The session failed: ${errorMessage}` : 'The session failed.';
    return answer ? `${failure}\n\nIts last reply:\n${answer}` : failure;
  }
  const stopped = 'The session was stopped before it finished.';
  return answer ? `${stopped}\n\nIts last reply:\n${answer}` : stopped;
};

/** The synthetic message that carries a dispatched session's result to its parent. */
export const buildDispatchResultMessage = ({ sessionId, title, model = '', outcome }) => {
  const label = title || 'Dispatched session';
  const modelAttribute = model ? ` model="${escapeAttribute(model)}"` : '';
  const attributes = `sessionID="${escapeAttribute(sessionId)}" state="${outcome.state}" title="${escapeAttribute(label)}"${modelAttribute}`;
  const metadata = { source: DISPATCH_RESULT_SOURCE, sessionID: sessionId, state: outcome.state };
  if (title) metadata.title = title;
  if (model) metadata.model = model;
  return {
    text: `<openchamber-session ${attributes}>\n${outcomeBody(outcome, sessionId)}\n</openchamber-session>`,
    description: label,
    metadata,
  };
};

const UPDATE_LABELS = { started: 'started', running: 'update', waiting: 'waiting for an answer', background: 'waiting for background work' };

const updateBody = (kind, detail) => {
  if (kind === 'started') return 'It started working on the prompt. Its final answer will be delivered to you when it finishes.';
  if (kind === 'waiting') return `It is blocked until this is answered on its card:\n${detail}`;
  if (kind === 'background') return `Its turn ended while background work still runs. Its final answer will be delivered to you once that work finishes and it has answered:\n${detail}`;
  return `It is still working. Its latest message:\n${detail}`;
};

export const buildDispatchUpdateMessage = ({ sessionId, title, model = '', kind, detail = '' }) => {
  const label = title || 'Dispatched session';
  const who = model ? `${label} (${model}, session ${sessionId})` : `${label} (session ${sessionId})`;
  const metadata = { source: DISPATCH_UPDATE_SOURCE, sessionID: sessionId, state: kind };
  if (title) metadata.title = title;
  if (model) metadata.model = model;
  return {
    text: `Update from the session you dispatched, ${who}: ${updateBody(kind, detail)}`,
    description: `${model ? `${model} · ` : ''}${label}: ${UPDATE_LABELS[kind]}`,
    metadata,
  };
};

const DELETED_OUTCOME = { idleId: 'deleted', state: 'cancelled', text: '', errorMessage: '' };

export function createDispatchResultsRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir,
  // Archive is OpenChamber's: an archived parent records the answer but is not woken.
  isSessionArchived = async () => false,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  settleRecheckMs = SETTLE_RECHECK_MS,
  updateIntervalMs = UPDATE_INTERVAL_MS,
}) {
  const filePath = path.join(dataDir, FILE_NAME);

  /** entry id → { id, parentSessionId, sessionId, dispatchedAt, messageId? } */
  const entries = new Map();
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  // In memory only: a restart starts every watched session from a fresh tick.
  const timers = new Map(); // watched sessionId → timeout
  const failures = new Map(); // watched sessionId → consecutive failed ticks
  const settleChecks = new Map(); // watched sessionId → rechecks spent waiting for the idle record
  const ticking = new Set(); // watched sessionIds with a tick in flight
  const updateTimers = new Map();
  const reportedUpdates = new Map();
  const parentChains = new Map();
  let modelNames = null;

  // --- persistence ---------------------------------------------------------

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return [];
      throw error;
    }
    let stored = null;
    let reason = 'not a dispatch results file';
    try {
      stored = parse(storedFileSchema, JSON.parse(raw));
    } catch (error) {
      reason = error?.message ?? String(error);
    }
    if (!stored) {
      // Malformed is a failure, not "nothing pending": keep the bytes and
      // start over rather than overwrite them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[dispatch-results] file was unreadable and moved to ${backup}: ${reason}`);
      return [];
    }
    // One unreadable entry is dropped alone; the rest still deliver.
    return stored.entries.map((entry) => parse(entrySchema, entry)).filter(Boolean);
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const entry of stored) if (!entries.has(entry.id)) entries.set(entry.id, entry);
        })
        .catch((error) => {
          // A failed read must not pass for "nothing pending": the next write
          // would clobber the file, so writes wait for a load that succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, entries: Array.from(entries.values()) });
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    // The chain survives a failed write so later writes still run; the caller
    // still sees this one fail, since "on disk" is what it waits for.
    writePromise = write.catch((error) => {
      console.warn('[dispatch-results] failed to persist pending results:', error?.message ?? error);
    });
    return write;
  };

  // --- OpenCode access -----------------------------------------------------

  const openCodeRequest = async (fetchPath, { method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  /**
   * Where the watched session stands: `running`, `ended` with its record page
   * and title, `deleted`, or null when OpenCode could not be asked. Unknown is
   * never "ended": a failed read retries instead of reporting a guess.
   */
  const readWatchedSession = async (sessionId) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionId]) return { kind: 'running' };
    // A turn is over only when its subagents are done too: the session idles
    // while a background subagent works and runs again on its result.
    const subagentsWorking = await activityProbe.hasWorkingChildren(sessionId, statuses);
    if (subagentsWorking === null) return null;
    if (subagentsWorking) return { kind: 'subagents' };
    const encoded = encodeURIComponent(sessionId);
    try {
      const session = parse(sessionRecordSchema, await openCodeRequest(`/api/session/${encoded}`));
      const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encoded}/message`, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      }));
      // An answer that is not a page is unknown, never an empty history.
      if (!page) return null;
      return { kind: 'ended', title: session?.title?.trim() ?? '', model: await describeModel(session?.model), records: page.data };
    } catch (error) {
      if (error?.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  const readModelNames = async () => {
    if (modelNames && now() - modelNames.at < MODEL_NAMES_TTL_MS) return modelNames.names;
    const models = parse(modelListSchema, await openCodeRequest('/api/model')) ?? [];
    const providers = parse(providerListSchema, await openCodeRequest('/api/provider')) ?? [];
    const providerNames = new Map(providers.filter(Boolean).map((provider) => [provider.id, provider.name]));
    const names = new Map(models.filter(Boolean).map((model) => [
      `${model.providerID}/${model.id}`,
      [providerNames.get(model.providerID), model.name].filter(Boolean).join(' '),
    ]));
    modelNames = { at: now(), names };
    return names;
  };

  const describeModel = async (model) => {
    if (!model) return '';
    const key = `${model.providerID}/${model.id}`;
    const names = await readModelNames().catch(() => null);
    return names?.get(key) || key;
  };

  const readSessionHeader = async (sessionId) => {
    const session = parse(sessionRecordSchema, await openCodeRequest(`/api/session/${encodeURIComponent(sessionId)}`).catch(() => null));
    return { title: session?.title?.trim() ?? '', model: await describeModel(session?.model) };
  };

  const resumeFor = async (parentSessionId) => {
    // The archive store answers asynchronously; reading its Promise as a
    // value made every parent look archived, so none was ever woken. A failed
    // lookup wakes: the agent asked for this result.
    const archived = await Promise.resolve(isSessionArchived(parentSessionId)).catch(() => false);
    return archived !== true;
  };

  const postSynthetic = (parentSessionId, body) => openCodeRequest(`/api/session/${encodeURIComponent(parentSessionId)}/synthetic`, {
    method: 'POST',
    body: { ...body, delivery: 'steer' },
  });

  const inParentOrder = (parentSessionId, task) => {
    const run = (parentChains.get(parentSessionId) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => undefined);
    parentChains.set(parentSessionId, settled);
    void settled.then(() => {
      if (parentChains.get(parentSessionId) === settled) parentChains.delete(parentSessionId);
    });
    return run;
  };

  const parentsOf = (sessionId) => new Set(pendingFor(sessionId).map((entry) => entry.parentSessionId));

  const report = async (sessionId, kind, detail = '') => {
    const parents = parentsOf(sessionId);
    if (stopped || parents.size === 0) return;
    const header = await readSessionHeader(sessionId);
    const message = buildDispatchUpdateMessage({ sessionId, ...header, kind, detail });
    await Promise.all(Array.from(parents, (parentSessionId) => inParentOrder(parentSessionId, async () => {
      const resume = kind === 'waiting' && await resumeFor(parentSessionId);
      await postSynthetic(parentSessionId, { id: createMessageId(now()), ...message, resume });
    }).catch((error) => {
      console.warn(`[dispatch-results] could not tell ${parentSessionId} about ${sessionId}:`, error?.message ?? error);
    })));
  };

  const clearUpdateTimer = (sessionId) => {
    const existing = updateTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      updateTimers.delete(sessionId);
    }
  };

  const armUpdate = (sessionId) => {
    if (stopped || updateTimers.has(sessionId) || pendingFor(sessionId).length === 0) return;
    const timer = setTimeout(() => {
      updateTimers.delete(sessionId);
      reportProgress(sessionId).catch((error) => {
        console.warn('[dispatch-results] progress update failed:', error?.message ?? error);
      });
    }, updateIntervalMs);
    timer.unref?.();
    updateTimers.set(sessionId, timer);
  };

  async function reportProgress(sessionId) {
    if (stopped || pendingFor(sessionId).length === 0) return;
    const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
    }));
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    const summary = page ? latestAssistantSummary(page.data) : '';
    if (summary && summary !== reportedUpdates.get(sessionId)) {
      reportedUpdates.set(sessionId, summary);
      await report(sessionId, 'running', summary);
    }
    if (statuses?.[sessionId]) armUpdate(sessionId);
  }

  /** Admits the result into the parent. Resolves true when it is there (now or before). */
  const deliver = async (entry, message) => {
    const resume = await resumeFor(entry.parentSessionId);
    try {
      await inParentOrder(entry.parentSessionId, () => postSynthetic(entry.parentSessionId, { id: entry.messageId, ...message, resume }));
      return true;
    } catch (error) {
      // The id is ours and was admitted before: an earlier attempt landed.
      if (error?.status === 409) return true;
      // The parent is gone; nobody is left to tell.
      if (error?.status === 404) {
        console.log(`[dispatch-results] dropping the result of ${entry.sessionId}: session ${entry.parentSessionId} no longer exists`);
        return true;
      }
      throw error;
    }
  };

  // --- delivery loop -------------------------------------------------------

  const pendingFor = (sessionId) => Array.from(entries.values()).filter((entry) => entry.sessionId === sessionId);

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const arm = (sessionId, delayMs = quietMs) => {
    if (stopped || pendingFor(sessionId).length === 0) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((error) => {
        console.warn('[dispatch-results] tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const retryLater = (sessionId) => {
    const count = (failures.get(sessionId) ?? 0) + 1;
    failures.set(sessionId, count);
    arm(sessionId, retryDelayMs(count));
  };

  async function tick(sessionId) {
    if (stopped || pendingFor(sessionId).length === 0) return;
    // An idle event that lands while a tick is still reading must not be
    // lost: that tick may have seen the session running a moment earlier.
    if (ticking.has(sessionId)) return arm(sessionId);
    ticking.add(sessionId);
    try {
      const watched = await readWatchedSession(sessionId);
      if (watched === null) return retryLater(sessionId);
      // Running: its next idle event re-arms the tick.
      if (watched.kind === 'running') return;
      if (watched.kind === 'subagents') return arm(sessionId, subagentRecheckMs);

      let waiting = false;
      const deliveredTurns = new Set();
      for (const entry of pendingFor(sessionId)) {
        const outcome = watched.kind === 'deleted'
          ? DELETED_OUTCOME
          : readDispatchOutcome(watched.records, entry.dispatchedAt, entry.afterIdleId);
        if (!outcome) {
          waiting = true;
          continue;
        }
        const turnKey = `${entry.parentSessionId}\n${outcome.idleId}`;
        if (deliveredTurns.has(turnKey)) {
          entries.delete(entry.id);
          await persist();
          continue;
        }
        if (!entry.messageId) {
          // Persisted before the first attempt, so a retry reuses it.
          entry.messageId = createMessageId(now());
          try {
            await persist();
          } catch (error) {
            // Unsaved, it could be minted again after a crash and deliver twice.
            delete entry.messageId;
            throw error;
          }
        }
        const message = buildDispatchResultMessage({
          sessionId,
          title: watched.kind === 'ended' ? watched.title : '',
          model: watched.kind === 'ended' ? watched.model : '',
          outcome,
        });
        await deliver(entry, message);
        deliveredTurns.add(turnKey);
        entries.delete(entry.id);
        await persist();
        console.log(`[dispatch-results] delivered the ${outcome.state} result of ${sessionId} to ${entry.parentSessionId}`);
      }
      failures.delete(sessionId);

      if (!waiting) {
        settleChecks.delete(sessionId);
        clearUpdateTimer(sessionId);
        reportedUpdates.delete(sessionId);
        return;
      }
      // Idle, yet the run's idle record is not there: either the record trails
      // the event briefly, or the dispatched prompt has not started. A few
      // short rechecks cover the first; the next idle event covers the second.
      const spent = settleChecks.get(sessionId) ?? 0;
      if (spent < SETTLE_RECHECKS) {
        settleChecks.set(sessionId, spent + 1);
        arm(sessionId, settleRecheckMs);
      }
    } catch (error) {
      console.warn(`[dispatch-results] delivering the result of ${sessionId} failed:`, error?.message ?? error);
      retryLater(sessionId);
    } finally {
      ticking.delete(sessionId);
    }
  }

  const reconcileAll = () => {
    for (const sessionId of new Set(Array.from(entries.values(), (entry) => entry.sessionId))) {
      if (!timers.has(sessionId)) arm(sessionId);
    }
  };

  // --- public --------------------------------------------------------------

  /**
   * Watches `sessionId` for the end of the turn dispatched at `dispatchedAt`
   * and delivers its result to `parentSessionId`. Resolves once the entry is
   * on disk, so a restart right after the tool answers still delivers.
   */
  const register = async ({ parentSessionId, sessionId, dispatchedAt, afterIdleId }) => {
    const parent = parse(sessionIdSchema, parentSessionId);
    const watched = parse(sessionIdSchema, sessionId);
    if (!parent || !watched) throw new TypeError('parentSessionId and sessionId must be session ids');
    if (parent === watched) throw new TypeError('a session cannot return its result to itself');
    const at = parse(timeSchema, dispatchedAt);
    if (at === null) throw new TypeError('dispatchedAt must be a timestamp');
    await load();
    const entry = { id: `dispatch-${now()}-${Math.random().toString(36).slice(2, 9)}`, parentSessionId: parent, sessionId: watched, dispatchedAt: at };
    // Kept only when it is a real baseline (an id, or null for "none yet").
    const baseline = afterIdleSchema.safeParse(afterIdleId);
    if (afterIdleId !== undefined && baseline.success) entry.afterIdleId = baseline.data;
    entries.set(entry.id, entry);
    if (entries.size > MAX_ENTRIES) {
      const oldest = Array.from(entries.values())
        .filter((candidate) => candidate.id !== entry.id)
        .sort((left, right) => left.dispatchedAt - right.dispatchedAt)
        .slice(0, entries.size - MAX_ENTRIES);
      for (const stale of oldest) {
        entries.delete(stale.id);
        console.warn(`[dispatch-results] too many pending results; no longer waiting on ${stale.sessionId} for ${stale.parentSessionId}`);
      }
    }
    try {
      await persist();
    } catch (error) {
      // The caller tells the agent no result is coming; delivering one anyway
      // would contradict it.
      entries.delete(entry.id);
      throw error;
    }
    // The session may already be done: a short turn can end before this
    // entry existed, and its idle event would then have found nothing to arm.
    arm(watched);
    void report(watched, 'started').then(() => armUpdate(watched));
    return { id: entry.id };
  };

  const processPayload = (payload) => {
    if (stopped) return;

    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      const deletedSessionId = deleted.properties.sessionID;
      // A deleted parent has nobody left to tell; a deleted dispatched session
      // still reports, as stopped, so the agent is not left waiting.
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.parentSessionId === deletedSessionId) {
          entries.delete(entry.id);
          changed = true;
        }
      }
      // Logged by persist; the next write saves the same state again.
      if (changed) persist().catch(() => undefined);
      arm(deletedSessionId);
      return;
    }

    const form = parse(formEventSchema, payload);
    if (form) {
      const { sessionID, form: asked } = form.properties;
      if (pendingFor(sessionID).length === 0) return;
      const questions = asked.fields.map((field) => field?.title?.trim()).filter(Boolean);
      const detail = (questions.length > 0 ? questions : [asked.title?.trim() || 'A question']).join('\n');
      void report(sessionID, 'waiting', detail);
      return;
    }

    const background = parse(backgroundEventSchema, payload);
    if (background) {
      const { sessionID, tasks } = background.properties;
      if (pendingFor(sessionID).length === 0) return;
      const descriptions = tasks.map((task) => task?.description.trim()).filter(Boolean);
      void report(sessionID, 'background', (descriptions.length > 0 ? descriptions : ['A background task']).join('\n'));
      return;
    }

    const permission = parse(permissionEventSchema, payload);
    if (permission) {
      const { sessionID, action, message } = permission.properties;
      if (pendingFor(sessionID).length === 0) return;
      void report(sessionID, 'waiting', `Permission request: ${[action, message].filter(Boolean).join(': ') || 'a tool call'}`);
      return;
    }

    const status = parse(statusEventSchema, payload);
    if (!status) return;
    const sessionId = status.properties.sessionID;
    if (pendingFor(sessionId).length === 0) return;
    if (status.properties.status.type === 'idle') {
      settleChecks.delete(sessionId);
      clearUpdateTimer(sessionId);
      arm(sessionId);
    } else {
      clearTimer(sessionId);
      armUpdate(sessionId);
    }
  };

  const processEvent = (event) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    globalEventHub.start();
    void load()
      .then(() => {
        if (entries.size > 0) console.log(`[dispatch-results] restored ${entries.size} pending result(s)`);
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[dispatch-results] failed to load pending results:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of updateTimers.values()) clearTimeout(timer);
    updateTimers.clear();
  };

  return {
    load,
    register,
    processPayload,
    start,
    stop,
    /** Pending entries, oldest first; tests and diagnostics read it. */
    pending: () => Array.from(entries.values()).sort((left, right) => left.dispatchedAt - right.dispatchedAt),
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => writePromise,
  };
}

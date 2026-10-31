import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDispatchResultMessage,
  buildDispatchUpdateMessage,
  createDispatchResultsRuntime,
  latestAssistantSummary,
  readDispatchOutcome,
} from './runtime.js';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  // Stop first and drain writes, so no timer or write outlives its directory.
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeDataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-dispatch-results-'));
  temporaryDirectories.push(directory);
  return directory;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const assistant = (text, created, extra = {}) => ({
  type: 'assistant',
  id: `msg_a${created}`,
  content: [{ type: 'text', text }],
  time: { created, completed: created + 1 },
  ...extra,
});
const idle = (outcome, created) => ({ type: 'idle', id: `msg_i${created}`, outcome, time: { created } });
const user = (created) => ({ type: 'user', id: `msg_u${created}`, text: 'go', time: { created } });

/**
 * A stand-in for the OpenCode routes the runtime reads and writes. Records
 * are kept oldest first and served newest first, as `order: desc` does.
 */
const createOpenCode = () => {
  const state = {
    active: {},
    children: {},
    sessions: { ses_child: { id: 'ses_child', title: 'Fix the toolbar' } },
    records: { ses_child: [] },
    synthetic: [],
    updates: [],
    syntheticStatus: [],
    seenIds: new Set(),
    models: null,
    providers: null,
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/session/active') return json({ data: state.active });
    if (pathname === '/api/model' && state.models) return json({ data: state.models });
    if (pathname === '/api/provider' && state.providers) return json({ data: state.providers });
    if (pathname === '/api/session') {
      const parentID = searchParams.get('parentID');
      return json({ data: (state.children[parentID] ?? []).map((id) => ({ id })), cursor: {} });
    }
    const synthetic = pathname.match(/^\/api\/session\/([^/]+)\/synthetic$/);
    if (synthetic && init.method === 'POST' && JSON.parse(init.body).metadata?.source === 'openchamber-session-update') {
      state.updates.push({ sessionID: decodeURIComponent(synthetic[1]), ...JSON.parse(init.body) });
      return json({ data: {} });
    }
    if (synthetic && init.method === 'POST') {
      const status = state.syntheticStatus.shift();
      if (status) return json({ error: 'nope' }, status);
      const body = JSON.parse(init.body);
      if (state.seenIds.has(body.id)) return json({ error: 'conflict' }, 409);
      state.seenIds.add(body.id);
      state.synthetic.push({ sessionID: decodeURIComponent(synthetic[1]), ...body });
      return json({ data: { id: body.id } });
    }
    const messages = pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (messages) {
      const id = decodeURIComponent(messages[1]);
      if (!state.sessions[id]) return json({ error: 'not found' }, 404);
      return json({ data: [...(state.records[id] ?? [])].reverse(), cursor: {} });
    }
    const session = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (session) {
      const id = decodeURIComponent(session[1]);
      return state.sessions[id] ? json(state.sessions[id]) : json({ error: 'not found' }, 404);
    }
    return json({ error: `unexpected ${pathname}` }, 500);
  });
  return { state, fetchImpl };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), ...overrides } = {}) => {
  const directory = dataDir ?? await makeDataDir();
  const listeners = { event: [], status: [] };
  const globalEventHub = {
    subscribeEvent: (listener) => { listeners.event.push(listener); return () => {}; },
    subscribeStatus: (listener) => { listeners.status.push(listener); return () => {}; },
    start: vi.fn(),
  };
  const runtime = createDispatchResultsRuntime({
    globalEventHub,
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    dataDir: directory,
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs: () => 10,
    subagentRecheckMs: 10,
    settleRecheckMs: 10,
    ...overrides,
  });
  runtimes.push(runtime);
  const emit = (payload) => runtime.processPayload(payload);
  return { runtime, openCode, dataDir: directory, emit, listeners, globalEventHub };
};

const syntheticCallIndex = (openCode, source) => openCode.fetchImpl.mock.calls.findIndex(([url, init]) => url.endsWith('/synthetic')
  && JSON.parse(init.body).metadata.source === source);

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('readDispatchOutcome', () => {
  it('reads the answer of the turn that ended after the dispatch', () => {
    // Newest first, as the message route serves them.
    const records = [idle('succeeded', 30), assistant('Done: toolbar fixed', 20), user(15), idle('succeeded', 5), assistant('older', 4)];
    expect(readDispatchOutcome(records, 10)).toMatchObject({ state: 'completed', text: 'Done: toolbar fixed', errorMessage: '' });
  });

  it('is not done while the newest run ended before the dispatch', () => {
    expect(readDispatchOutcome([idle('succeeded', 5), assistant('older', 4)], 10)).toBeNull();
    expect(readDispatchOutcome([user(12)], 10)).toBeNull();
  });

  it('matches the turn by record order when the baseline is known, whatever the clocks say', () => {
    // OpenCode's clock lags OpenChamber's: every record looks older than the
    // dispatch at 1000, yet a newer idle record than the baseline ended the turn.
    const records = [idle('succeeded', 30), assistant('Done on the remote', 20), user(15), idle('succeeded', 5), assistant('older', 4)];
    expect(readDispatchOutcome(records, 1000, 'msg_i5')).toMatchObject({ state: 'completed', text: 'Done on the remote', errorMessage: '' });
    // The baseline is still the newest idle record: the turn has not ended.
    expect(readDispatchOutcome([idle('succeeded', 5), assistant('older', 4)], 1000, 'msg_i5')).toBeNull();
    // A session with no run before the dispatch: its first idle record ends the turn.
    expect(readDispatchOutcome([idle('succeeded', 30), assistant('first', 20), user(15)], 1000, null))
      .toMatchObject({ state: 'completed', text: 'first', errorMessage: '' });
    // A reply from before the baseline is never this turn's answer.
    expect(readDispatchOutcome([idle('succeeded', 30), user(15), idle('succeeded', 5), assistant('older', 4)], 1000, 'msg_i5'))
      .toMatchObject({ state: 'completed', text: '', errorMessage: '' });
  });

  it('names the idle record that ended the turn', () => {
    expect(readDispatchOutcome([idle('succeeded', 30), assistant('Done', 20)], 10)?.idleId).toBe('msg_i30');
  });

  it('reports a failed and a stopped turn as their states', () => {
    expect(readDispatchOutcome([idle('failed', 30), assistant('', 20, { error: { type: 'APIError', message: 'rate limited' } })], 10))
      .toMatchObject({ state: 'error', text: '', errorMessage: 'rate limited' });
    expect(readDispatchOutcome([idle('interrupted', 30), assistant('half', 20)], 10)?.state).toBe('cancelled');
  });

  it('never hands back a reply from before the dispatch', () => {
    expect(readDispatchOutcome([idle('succeeded', 30), assistant('older', 4)], 10)).toMatchObject({ state: 'completed', text: '', errorMessage: '' });
  });
});

describe('buildDispatchResultMessage', () => {
  it('wraps the answer in an envelope the UI and the agent can read', () => {
    const message = buildDispatchResultMessage({
      sessionId: 'ses_child',
      title: 'Say "hi" <now>',
      outcome: { state: 'completed', text: 'Hello', errorMessage: '' },
    });
    expect(message.text).toBe('<openchamber-session sessionID="ses_child" state="completed" title="Say &quot;hi&quot; &lt;now&gt;">\nHello\n</openchamber-session>');
    expect(message.metadata).toEqual({ source: 'openchamber-session', sessionID: 'ses_child', state: 'completed', title: 'Say "hi" <now>' });
    expect(message.description).toBe('Say "hi" <now>');
  });

  it('states a failure and a stop instead of an empty answer', () => {
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'error', text: '', errorMessage: 'boom' } }).text)
      .toContain('The session failed: boom');
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'cancelled', text: 'partial', errorMessage: '' } }).text)
      .toContain('The session was stopped before it finished.\n\nIts last reply:\npartial');
    expect(buildDispatchResultMessage({ sessionId: 'ses_c', title: '', outcome: { state: 'completed', text: '', errorMessage: '' } }).text)
      .toContain('without a text reply');
  });
});

describe('latestAssistantSummary', () => {
  it('returns the last paragraph of the newest assistant reply that has text', () => {
    const records = [idle('succeeded', 40), assistant('', 30), user(25), assistant('Early notes\n\nLatest paragraph\n', 20), assistant('older', 10)];
    expect(latestAssistantSummary(records)).toBe('Latest paragraph');
  });

  it('is empty when no assistant reply has text', () => {
    expect(latestAssistantSummary([idle('succeeded', 40), assistant('', 30), user(25)])).toBe('');
  });

  it('cuts a long paragraph to its last 400 characters', () => {
    const summary = latestAssistantSummary([assistant(`${'a'.repeat(100)}${'b'.repeat(400)}`, 20)]);
    expect(summary).toBe(`…${'b'.repeat(400)}`);
  });
});

describe('buildDispatchUpdateMessage', () => {
  it.each([
    ['started', '', 'Fix the toolbar: started', 'It started working on the prompt'],
    ['running', 'Compiling', 'Fix the toolbar: update', 'It is still working. Its latest message:\nCompiling'],
    ['waiting', 'Which color?', 'Fix the toolbar: waiting for an answer', 'It is blocked until this is answered on its card:\nWhich color?'],
  ])('describes a %s update', (kind, detail, description, body) => {
    const message = buildDispatchUpdateMessage({ sessionId: 'ses_child', title: 'Fix the toolbar', kind, detail });
    expect(message.description).toBe(description);
    expect(message.text).toContain('Fix the toolbar (session ses_child)');
    expect(message.text).toContain(body);
    expect(message.metadata).toEqual({ source: 'openchamber-session-update', sessionID: 'ses_child', state: kind, title: 'Fix the toolbar' });
  });

  it('puts the model in the description, the text and the metadata', () => {
    const message = buildDispatchUpdateMessage({ sessionId: 'ses_child', title: 'Fix', model: 'Claude Code Sonnet 5.5', kind: 'started' });
    expect(message.description).toBe('Claude Code Sonnet 5.5 · Fix: started');
    expect(message.text).toContain('Fix (Claude Code Sonnet 5.5, session ses_child)');
    expect(message.metadata.model).toBe('Claude Code Sonnet 5.5');
  });
});

describe('dispatch results runtime', () => {
  it('delivers the answer to the parent and wakes it once the turn ends', async () => {
    const { runtime, openCode, emit, dataDir } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    // Running: nothing is delivered and nothing polls it.
    expect(openCode.state.synthetic).toEqual([]);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Toolbar fixed', 20), idle('succeeded', 30));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.synthetic).toEqual([expect.objectContaining({
      sessionID: 'ses_parent',
      id: expect.stringMatching(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/),
      text: expect.stringContaining('Toolbar fixed'),
      description: 'Fix the toolbar',
      metadata: { source: 'openchamber-session', sessionID: 'ses_child', state: 'completed', title: 'Fix the toolbar' },
      delivery: 'steer',
      resume: true,
    })]);
    expect(runtime.pending()).toEqual([]);
    await runtime.flush();
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'dispatch-results.json'), 'utf8'));
    expect(stored.entries).toEqual([]);
  });

  it('delivers a turn that ended before the entry existed', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Quick answer', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toHaveLength(1);
  });

  it('waits for the dispatched session\'s subagents before calling the turn over', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Waiting on a subagent', 12), idle('succeeded', 13));
    openCode.state.children.ses_child = ['ses_grandchild'];
    openCode.state.active.ses_grandchild = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([]);

    delete openCode.state.active.ses_grandchild;
    openCode.state.records.ses_child.push(assistant('Final answer', 40), idle('succeeded', 41));
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Final answer') })]);
  });

  it('records the answer in an archived parent without waking it', async () => {
    // Async like the real archive store.
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async (id) => id === 'ses_parent' });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: false })]);
  });

  it('wakes a parent the async archive store reports as not archived', async () => {
    // Seen live: the store's Promise was read as "archived", and no parent woke.
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async () => false });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: true })]);
  });

  it('wakes the parent when the archive lookup fails', async () => {
    const { runtime, openCode } = await createRuntime({ isSessionArchived: async () => { throw new Error('store down'); } });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ resume: true })]);
  });

  it('retries a failed delivery with the same message id, so it lands once', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    openCode.state.syntheticStatus.push(500);
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();

    const posts = openCode.fetchImpl.mock.calls
      .filter(([url, init]) => url.endsWith('/synthetic') && JSON.parse(init.body).metadata.source === 'openchamber-session')
      .map(([, init]) => JSON.parse(init.body).id);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    expect(openCode.state.synthetic).toHaveLength(1);
    expect(runtime.pending()).toEqual([]);
  });

  it('treats an id OpenCode already admitted as delivered', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    openCode.state.syntheticStatus.push(409);
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(runtime.pending()).toEqual([]);
  });

  it('drops the delivery when the parent no longer exists', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    openCode.state.syntheticStatus.push(404);
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(runtime.pending()).toEqual([]);
  });

  it('forgets results owed to a parent that was deleted', async () => {
    const { runtime, openCode, emit, dataDir } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({ type: 'session.deleted', properties: { sessionID: 'ses_parent', info: { id: 'ses_parent' } } });
    expect(runtime.pending()).toEqual([]);
    await runtime.flush();
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'dispatch-results.json'), 'utf8'));
    expect(stored.entries).toEqual([]);
  });

  it('reports a dispatched session deleted before it finished as stopped', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    delete openCode.state.active.ses_child;
    delete openCode.state.sessions.ses_child;
    emit({ type: 'session.deleted', properties: { sessionID: 'ses_child', info: { id: 'ses_child' } } });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({
      metadata: { source: 'openchamber-session', sessionID: 'ses_child', state: 'cancelled' },
      text: expect.stringContaining('stopped before it finished'),
    })]);
  });

  it('retries when OpenCode cannot be asked, never guessing the turn is over', async () => {
    const openCode = createOpenCode();
    const original = openCode.fetchImpl.getMockImplementation();
    let failing = true;
    openCode.fetchImpl.mockImplementation(async (url, init) => {
      if (failing && url.includes('/api/session/active')) return json({ error: 'down' }, 503);
      return original(url, init);
    });
    const { runtime } = await createRuntime({ openCode });
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([]);

    failing = false;
    await settle();
    expect(openCode.state.synthetic).toHaveLength(1);
  });

  it('opens the shared event stream itself, so a result arrives while no browser is connected', async () => {
    const { runtime, globalEventHub } = await createRuntime();
    runtime.start();
    expect(globalEventHub.start).toHaveBeenCalledTimes(1);
  });

  it('delivers after a restart from what was persisted', async () => {
    const dataDir = await makeDataDir();
    const first = await createRuntime({ dataDir });
    first.openCode.state.active.ses_child = { type: 'running' };
    await first.runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    first.runtime.stop();

    const openCode = createOpenCode();
    openCode.state.records.ses_child.push(user(11), assistant('After restart', 12), idle('succeeded', 13));
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ sessionID: 'ses_parent', text: expect.stringContaining('After restart') })]);
  });

  it.each([['not JSON', '{ not json'], ['JSON of another shape', '{"version":1}']])('keeps a file that is %s aside instead of overwriting it', async (_label, content) => {
    const dataDir = await makeDataDir();
    await fs.writeFile(path.join(dataDir, 'dispatch-results.json'), content);
    const { runtime } = await createRuntime({ dataDir });
    await runtime.load();
    const files = await fs.readdir(dataDir);
    expect(files.some((name) => name.startsWith('dispatch-results.json.corrupt-'))).toBe(true);
    expect(runtime.pending()).toEqual([]);
  });

  it('fails a registration that did not reach the disk and forgets the entry', async () => {
    const dataDir = await makeDataDir();
    const { runtime, openCode } = await createRuntime({ dataDir });
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.load();
    // A directory where the file goes makes the atomic rename fail.
    await fs.mkdir(path.join(dataDir, 'dispatch-results.json'));
    await expect(runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 })).rejects.toThrow();
    expect(runtime.pending()).toEqual([]);
  });

  it('tells the parent when the session starts, before its final result', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.updates).toEqual([expect.objectContaining({
      sessionID: 'ses_parent',
      id: expect.stringMatching(/^msg_/),
      description: expect.stringMatching(/: started$/),
      metadata: { source: 'openchamber-session-update', sessionID: 'ses_child', state: 'started', title: 'Fix the toolbar' },
      resume: false,
      delivery: 'steer',
    })]);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Toolbar fixed', 20), idle('succeeded', 30));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.synthetic).toHaveLength(1);
    const started = syntheticCallIndex(openCode, 'openchamber-session-update');
    const finished = syntheticCallIndex(openCode, 'openchamber-session');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(finished);
  });

  it('tells a parent what a form is asking and wakes it', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({
      type: 'form.created',
      properties: { sessionID: 'ses_child', form: { id: 'f1', title: 'Pick', fields: [{ title: 'Which color?' }, { title: 'Which size?' }] } },
    });
    await settle();
    const waiting = openCode.state.updates.filter((update) => update.metadata.state === 'waiting');
    expect(waiting).toEqual([expect.objectContaining({ sessionID: 'ses_parent', resume: true })]);
    expect(waiting[0].text).toContain('Which color?');
    expect(waiting[0].text).toContain('Which size?');
  });

  it('does not wake an archived parent about a form', async () => {
    const { runtime, openCode, emit } = await createRuntime({ isSessionArchived: async () => true });
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({ type: 'form.created', properties: { sessionID: 'ses_child', form: { id: 'f1', title: 'Pick', fields: [{ title: 'Which color?' }] } } });
    await settle();
    const waiting = openCode.state.updates.filter((update) => update.metadata.state === 'waiting');
    expect(waiting).toEqual([expect.objectContaining({ resume: false })]);
  });

  it('ignores a form from a session nobody is waiting on', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    emit({ type: 'form.created', properties: { sessionID: 'ses_other', form: { id: 'f1', title: 'Pick', fields: [{ title: 'Which color?' }] } } });
    await settle();
    expect(openCode.state.updates.filter((update) => update.metadata.state === 'waiting')).toEqual([]);
  });

  it('tells the parent which permission the session is asking for', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({ type: 'permission.asked', properties: { sessionID: 'ses_child', action: 'bash', message: 'rm -rf build' } });
    await settle();
    const waiting = openCode.state.updates.filter((update) => update.metadata.state === 'waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].text).toContain('bash');
    expect(waiting[0].text).toContain('rm -rf build');
  });

  it('sends the latest paragraph while the session runs, only when it changed, and stops at idle', async () => {
    const { runtime, openCode, emit } = await createRuntime({ updateIntervalMs: 10 });
    openCode.state.active.ses_child = { type: 'running' };
    openCode.state.records.ses_child.push(user(11), assistant('Early notes\n\nReading the toolbar code', 12));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } });
    await settle();
    const running = () => openCode.state.updates.filter((update) => update.metadata.state === 'running');
    expect(running()).toHaveLength(1);
    expect(running()[0].text).toContain('Reading the toolbar code');
    expect(running()[0].text).not.toContain('Early notes');

    await settle();
    expect(running()).toHaveLength(1);

    openCode.state.records.ses_child.push(assistant('Now running the tests', 22));
    await settle();
    expect(running()).toHaveLength(2);
    expect(running()[1].text).toContain('Now running the tests');

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(assistant('Wrapped up', 32), idle('succeeded', 40));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await settle();
    expect(running()).toHaveLength(2);
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Wrapped up') })]);
  });

  it('delivers one result when two entries for the same parent end on the same turn', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active.ses_child = { type: 'running' };
    openCode.state.records.ses_child.push(idle('succeeded', 5));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10, afterIdleId: 'msg_i5' });
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 9, afterIdleId: null });
    expect(runtime.pending()).toHaveLength(2);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Done once', 12), idle('succeeded', 13));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({ text: expect.stringContaining('Done once') })]);
    expect(runtime.pending()).toEqual([]);
  });

  it('names the model of the session the way the model picker does', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.sessions.ses_child.model = { providerID: 'claude', id: 'sonnet' };
    openCode.state.models = [{ providerID: 'claude', id: 'sonnet', name: 'Sonnet 5.5' }];
    openCode.state.providers = [{ id: 'claude', name: 'Claude Code' }];
    openCode.state.active.ses_child = { type: 'running' };
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.updates[0].description).toMatch(/^Claude Code Sonnet 5\.5 · /);

    delete openCode.state.active.ses_child;
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    emit({ type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({
      text: expect.stringContaining('model="Claude Code Sonnet 5.5"'),
      metadata: expect.objectContaining({ model: 'Claude Code Sonnet 5.5' }),
    })]);
  });

  it('falls back to the provider and model ids when the model routes fail', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.sessions.ses_child.model = { providerID: 'claude', id: 'sonnet' };
    openCode.state.records.ses_child.push(user(11), assistant('Done', 12), idle('succeeded', 13));
    await runtime.register({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 10 });
    await settle();
    expect(openCode.state.synthetic).toEqual([expect.objectContaining({
      text: expect.stringContaining('model="claude/sonnet"'),
      metadata: expect.objectContaining({ model: 'claude/sonnet' }),
    })]);
  });

  it('refuses an entry that would report a session to itself', async () => {
    const { runtime } = await createRuntime();
    await expect(runtime.register({ parentSessionId: 'ses_same', sessionId: 'ses_same', dispatchedAt: 1 })).rejects.toThrow('itself');
  });
});

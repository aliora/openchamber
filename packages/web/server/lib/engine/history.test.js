import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerEngineRoutes } from './routes.js';
import { createEngineRegistry } from './registry.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { createFakeEngine } from './test/fake-engine.js';
import { describeToolResult } from '../agent-tool/runtime.js';

// `GET /api/session/:id/message` after a turn ran: the OpenCode 2.x page the
// UI reloads a chat from, and how it lines up with what the live stream drew.
// The first test records the page in `test/history-page.json`, which the UI's
// client test (packages/ui/src/lib/opencode/client.test.ts) feeds through the
// real `@opencode/client` and the projection.

const T0 = 1_792_000_000_000;
// What the UI mints for a prompt sent 16 ms before the server stored it
// (`ascendingId`), so the prompt sorts before its answer in that millisecond.
const PROMPT_ID = 'msg_13b85fff0001ClientPrompt01';

const PAGE_INPUT = {
  action: 'render.page',
  parameters: { title: 'Pick a database', html: '<p>Postgres or SQLite?</p>', awaitAnswer: true },
};
const PAGE_RESULT = JSON.stringify({
  schemaVersion: 1,
  ok: true,
  action: 'render.page',
  data: { answer: { answered: true, summary: 'Postgres', data: { choice: 'postgres' } } },
});

const tick = () => vi.setSystemTime(Date.now() + 1000);

const answer = (text, proc) => {
  if (text === 'Plan the storage') {
    tick();
    proc.emit('reasoning.delta', { text: 'The user should pick the database.' });
    tick();
    proc.emit('text.delta', { text: 'Here is the choice.' });
    tick();
    proc.emit('tool.started', { id: 'toolu_page', name: 'openchamber_render', input: {} });
    tick();
    proc.emit('tool.called', { id: 'toolu_page', name: 'openchamber_render', input: PAGE_INPUT });
    tick();
    proc.emit('tool.completed', { id: 'toolu_page', output: PAGE_RESULT, isError: false });
    tick();
    proc.emit('text.delta', { text: 'You picked Postgres.' });
    tick();
    proc.emit('reasoning.delta', { text: 'The storage notes should say why.' });
    tick();
    proc.emit('tool.called', { id: 'toolu_read', name: 'Read', input: { file_path: 'docs/storage.md' } });
    tick();
    proc.emit('tool.completed', { id: 'toolu_read', output: 'File does not exist.', isError: true });
    tick();
    proc.emit('text.delta', { text: 'There are no storage notes yet.' });
    tick();
    proc.emit('turn.completed', { outcome: 'succeeded', usage: { input: 1200, output: 340, reasoning: 80, cacheRead: 4000, cacheWrite: 0 } });
    return;
  }
  if (text === 'wait on a page') {
    proc.emit('reasoning.delta', { text: 'Asking first.' });
    proc.emit('tool.started', { id: 'toolu_wait', name: 'openchamber_render', input: {} });
    proc.emit('tool.called', { id: 'toolu_wait', name: 'openchamber_render', input: PAGE_INPUT });
    proc.emit('tool.started', { id: 'toolu_cmd', name: 'shell', input: { command: 'ls' } });
    return;
  }
  proc.emit('text.delta', { text: `echo: ${text}` });
  proc.emit('turn.completed', { outcome: 'succeeded' });
};

describe('engine history route', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let events;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-history-test-'));
    const streamHub = new StreamHub();
    events = [];
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push(event);
      broadcast(sessionId, event);
    };
    const toolServer = {
      grant: () => ({ server: { name: 'openchamber', url: 'http://127.0.0.1:1/mcp', token: 't' }, revoke: () => {}, noteUserMessage: () => {} }),
      describeResult: describeToolResult,
    };
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([createFakeEngine({ id: 'fake', reply: answer })]),
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      controlBridge: new ControlBridge(),
      streamHub,
      toolServer,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    vi.useRealTimers();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = async (url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const createSession = async () => (await request('/api/session', { engine: 'fake', location: { directory: '/work/repo' } })).body.data.id;

  it('serves a finished turn as the v2 messages the client reads, matching what the stream drew', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const id = await createSession();
    const prompt = await request(`/api/session/${id}/prompt`, { id: PROMPT_ID, text: 'Plan the storage' });
    expect(prompt.status).toBe(200);
    await settle();

    const page = (await request(`/api/session/${id}/message`)).body;
    expect(page.cursor).toEqual({ previous: null, next: null });
    const [assistant, user] = page.data;
    expect(user.id).toBe(PROMPT_ID);
    expect(assistant.id).toBe(prompt.body.data.id);

    // The live stream addressed the same messages, part ordinals, call ids and times.
    const live = (type) => events.filter((event) => event.type === type);
    expect(live('session.inbox.enqueued').map((event) => [event.data.inboxID, event.created])).toEqual([[user.id, user.time.created]]);
    expect(live('session.step.started').map((event) => [event.data.assistantMessageID, event.created])).toEqual([[assistant.id, assistant.time.created]]);
    const streamed = events.filter((event) => /^session\.(text|reasoning|tool)\./.test(event.type));
    expect(new Set(streamed.map((event) => event.data.assistantMessageID))).toEqual(new Set([assistant.id]));

    // Each run of text or reasoning streamed as a part of its own, named by
    // type and ordinal, and each call by its id. The UI names the n-th text or
    // reasoning item of the message read back as that type's part n
    // (projection.ts), so the reload draws the same parts in the same order.
    const order = ['reasoning:0', 'text:0', 'toolu_page', 'text:1', 'reasoning:1', 'toolu_read', 'text:2'];
    const liveKey = (event) => event.data.id ?? `${event.type.split('.')[1]}:${event.data.ordinal}`;
    expect([...new Set(streamed.map(liveKey))]).toEqual(order);
    const seen = { text: 0, reasoning: 0 };
    const reloadKeys = assistant.content.map((item) => (item.type === 'tool' ? item.id : `${item.type}:${seen[item.type]++}`));
    expect(reloadKeys).toEqual(order);
    // Every run ended on the stream with the text the history keeps for it.
    const runsEnded = events.filter((event) => /^session\.(text|reasoning)\.ended$/.test(event.type));
    expect(runsEnded.map((event) => [liveKey(event), event.data.text]))
      .toEqual(assistant.content.flatMap((item, index) => (item.type === 'tool' ? [] : [[reloadKeys[index], item.text]])));
    const reasoningEnded = live('session.reasoning.ended');
    expect(assistant.content.filter((item) => item.type === 'reasoning').map((item) => item.time))
      .toEqual(live('session.reasoning.started').map((event, index) => ({ created: event.created, completed: reasoningEnded[index].created })));
    const tools = Object.fromEntries(assistant.content.filter((item) => item.type === 'tool').map((item) => [item.id, item.time]));
    expect(live('session.tool.called').map((event) => event.created)).toEqual([tools.toolu_page.ran, tools.toolu_read.ran]);
    expect([...live('session.tool.success'), ...live('session.tool.failed')].map((event) => event.created))
      .toEqual([tools.toolu_page.completed, tools.toolu_read.completed]);
    const [ended] = live('session.step.ended');
    expect([ended.created, ended.data.finish, ended.data.tokens]).toEqual([assistant.time.completed, assistant.finish, assistant.tokens]);

    // The recording the UI test reads. The answer's id ends in random characters.
    const recorded = {
      ...page,
      data: page.data.map((message) => (message.id === assistant.id ? { ...message, id: `${message.id.slice(0, 16)}ServerAnswer01` } : message)),
    };
    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot('./test/history-page.json');
  });

  it('keeps a running turn in the history, so a reload still shows a page waiting for the user', async () => {
    const id = await createSession();
    await request(`/api/session/${id}/prompt`, { text: 'wait on a page' });
    await settle();

    const running = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(running.map((message) => message.type)).toEqual(['user', 'assistant']);
    const assistant = running[1];
    expect(assistant.time.completed).toBeUndefined();
    expect(assistant.finish).toBeUndefined();
    expect(assistant.content.map((item) => [item.type, item.state?.status])).toEqual([
      ['reasoning', undefined],
      ['tool', 'running'],
      ['tool', 'streaming'],
    ]);
    expect(assistant.content[1].state).toEqual({ status: 'running', input: PAGE_INPUT, metadata: {} });
    expect((await request(`/api/session/${id}/message/${assistant.id}`)).body.data).toEqual(assistant);

    // Stopping the turn stores it: the page reads as unanswered, the call only
    // started is gone, and nothing is listed twice.
    await request(`/api/session/${id}/abort`, {});
    const stored = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(stored.map((message) => message.id)).toEqual(running.map((message) => message.id));
    expect(stored[1].finish).toBe('unknown');
    expect(stored[1].time.completed).toEqual(expect.any(Number));
    expect(stored[1].content.map((item) => item.type)).toEqual(['reasoning', 'tool']);
    expect(stored[1].content[1].state).toMatchObject({ status: 'error', error: { message: 'The turn ended before this tool finished' } });
  });

  it('pages through the history with the limit, order and cursor the client sends', async () => {
    const id = await createSession();
    for (const text of ['one', 'two']) {
      await request(`/api/session/${id}/prompt`, { text });
      await settle();
    }
    const all = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(all.map((message) => message.type)).toEqual(['user', 'assistant', 'user', 'assistant']);

    const first = (await request(`/api/session/${id}/message?limit=3`)).body;
    expect(first.data.map((message) => message.id)).toEqual(all.slice(1).reverse().map((message) => message.id));
    expect(first.cursor.next).toEqual(expect.any(String));
    const second = (await request(`/api/session/${id}/message?limit=3&cursor=${first.cursor.next}`)).body;
    expect(second.data.map((message) => message.id)).toEqual([all[0].id]);
    expect(second.cursor).toEqual({ previous: null, next: null });

    const users = (await request(`/api/session/${id}/message?type=user&order=asc`)).body.data;
    expect(users.map((message) => message.text)).toEqual(['one', 'two']);

    const refused = async (query) => (await request(`/api/session/${id}/message?${query}`));
    expect(await refused(`cursor=${first.cursor.next}&order=asc`)).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError' } });
    expect(await refused('cursor=nonsense')).toMatchObject({ status: 400, body: { _tag: 'InvalidCursorError' } });
    expect(await refused('limit=0')).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError' } });
    expect((await request(`/api/session/${id}/message/msg_missing`))).toMatchObject({
      status: 404,
      body: { _tag: 'MessageNotFoundError', sessionID: id, messageID: 'msg_missing' },
    });
  });

  it('keeps the id the client sent for a prompt and refuses one that is taken or malformed', async () => {
    const id = await createSession();
    expect((await request(`/api/session/${id}/prompt`, { id: PROMPT_ID, text: 'one' })).status).toBe(200);
    await settle();

    const taken = await request(`/api/session/${id}/prompt`, { id: PROMPT_ID, text: 'again' });
    expect(taken).toMatchObject({ status: 409, body: { _tag: 'ConflictError' } });
    const malformed = await request(`/api/session/${id}/prompt`, { id: '../msg', text: 'again' });
    expect(malformed).toMatchObject({ status: 400, body: { _tag: 'InvalidRequestError', field: 'id' } });

    const users = (await request(`/api/session/${id}/message?type=user`)).body.data;
    expect(users.map((message) => [message.id, message.text])).toEqual([[PROMPT_ID, 'one']]);
  });
});

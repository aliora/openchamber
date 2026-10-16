import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { toolServerEnvironment } from './tool-server.js';

const PAGE_INPUT = { action: 'render.page', parameters: { title: 'Pick', html: '<p>Pick</p>', awaitAnswer: true } };

// The engine side of OpenChamber's tools: what a CLI reports, as the shared
// runtime turns it into wire events, stored parts and grant lifecycle.
const answer = (text, proc) => {
  if (text === 'show a page') {
    proc.emit('tool.started', { id: 'call_1', name: 'openchamber_render', input: {} });
    proc.emit('tool.called', { id: 'call_1', name: 'openchamber_render', input: PAGE_INPUT });
    proc.emit('tool.completed', { id: 'call_1', output: '{"ok":true}', isError: false });
    proc.emit('text.delta', { text: 'Shown.' });
    proc.emit('turn.completed', { outcome: 'succeeded' });
    return;
  }
  if (text === 'run a command') {
    // Some adapters report only the start of a call (Codex's commands, agy's tools).
    proc.emit('tool.started', { id: 'call_cmd', name: 'shell', input: { command: 'npm test' } });
    proc.emit('text.delta', { text: 'Tests pass.' });
    proc.emit('turn.completed', { outcome: 'succeeded' });
    return;
  }
  if (text === 'wait on a page') {
    proc.emit('tool.started', { id: 'call_w', name: 'openchamber_render', input: {} });
    proc.emit('tool.called', { id: 'call_w', name: 'openchamber_render', input: PAGE_INPUT });
    return;
  }
  if (text === 'written in the chat') {
    // The CLI takes this prompt into the running turn: the waiting call
    // returns, and one result answers both prompts.
    proc.emit('prompt.merged');
    proc.emit('tool.completed', { id: 'call_w', output: '{"answered":false}', isError: false });
    proc.emit('text.delta', { text: 'Read your message.' });
    proc.emit('turn.completed', { outcome: 'succeeded' });
    return;
  }
  proc.emit('text.delta', { text: `echo: ${text}` });
  proc.emit('turn.completed', { outcome: 'succeeded' });
};

const createFakeToolServer = ({ failGrant = false } = {}) => {
  const grants = [];
  return {
    grants,
    grant: ({ sessionId, directory }) => {
      if (failGrant) throw new Error('OpenChamber listener port is unavailable for managed tool injection');
      const record = { sessionId, directory, revoked: 0, userMessages: 0 };
      grants.push(record);
      return {
        server: { name: 'openchamber', url: 'http://127.0.0.1:3901/api/openchamber/mcp', token: `token-${grants.length}` },
        revoke: () => { record.revoked += 1; },
        noteUserMessage: () => { record.userMessages += 1; },
      };
    },
    describeResult: (name, output) => (name === 'openchamber_render' ? { openchamber: { ok: true, output } } : undefined),
  };
};

describe('engine runtime with a tool server', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let fake;
  let toolServer;
  let events;

  const start = (options = {}) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tool-server-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    const streamHub = new StreamHub();
    events = [];
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push(event);
      broadcast(sessionId, event);
    };
    fake = createFakeEngine({ id: 'fake', reply: answer });
    toolServer = createFakeToolServer(options);
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, { registry: createEngineRegistry([fake]), store, controlBridge: new ControlBridge(), streamHub, toolServer });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };

  beforeEach(() => start());

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (url, body) => {
    const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const createSession = async () => (await post('/api/session', { location: { directory: '/work/repo' } })).body.data.id;
  const storedAssistants = async (id) => (await store.getMessages(id)).filter((message) => message.role === 'assistant');

  it('grants each process its own tool server and revokes it when the process ends', async () => {
    const id = await createSession();
    await post(`/api/session/${id}/prompt`, { text: 'hello' });
    await settle();

    expect(toolServer.grants).toEqual([expect.objectContaining({ sessionId: id, directory: '/work/repo', revoked: 0 })]);
    expect(fake.processes[0].options.toolServer).toEqual({ name: 'openchamber', url: 'http://127.0.0.1:3901/api/openchamber/mcp', token: 'token-1' });

    await post(`/api/session/${id}/abort`, {});
    expect(toolServer.grants[0].revoked).toBe(1);

    // A new process is a new grant; the old token stays revoked.
    await post(`/api/session/${id}/prompt`, { text: 'again' });
    await settle();
    expect(fake.processes[1].options.toolServer.token).toBe('token-2');
    expect(toolServer.grants.map((grant) => grant.revoked)).toEqual([1, 0]);
  });

  it('runs the session without tools when the tool server cannot grant one', async () => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    start({ failGrant: true });
    const id = await createSession();
    const res = await post(`/api/session/${id}/prompt`, { text: 'hello' });
    await settle();

    expect(res.status).toBe(200);
    expect(fake.processes[0].options.toolServer).toBeUndefined();
    expect(events.at(-1).type).toBe('session.idle');
  });

  it('turns a tool call into wire events and stores it with the metadata the chat reads', async () => {
    const id = await createSession();
    await post(`/api/session/${id}/prompt`, { text: 'show a page' });
    await settle();

    const tool = events.filter((event) => event.type.startsWith('session.tool.'));
    expect(tool.map((event) => event.type)).toEqual(['session.tool.input.started', 'session.tool.called', 'session.tool.success']);
    expect(tool[0].data).toMatchObject({ id: 'call_1', name: 'openchamber_render', sessionID: id });
    expect(tool[1].data).toMatchObject({ id: 'call_1', input: PAGE_INPUT, executed: true });
    expect(tool[2].data).toMatchObject({
      id: 'call_1',
      content: [{ type: 'text', text: '{"ok":true}' }],
      metadata: { openchamber: { ok: true, output: '{"ok":true}' } },
      executed: true,
    });

    const [assistant] = await storedAssistants(id);
    expect(assistant.parts.map((part) => part.type)).toEqual(['tool', 'text']);
    expect(assistant.parts[0]).toEqual({
      id: 'call_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'openchamber_render',
      state: { status: 'completed', input: PAGE_INPUT, output: '{"ok":true}', metadata: { openchamber: { ok: true, output: '{"ok":true}' } } },
    });
  });

  it('fails a call its turn left open, so no client shows it running', async () => {
    const id = await createSession();
    await post(`/api/session/${id}/prompt`, { text: 'wait on a page' });
    await settle();
    await post(`/api/session/${id}/abort`, {});

    const failed = events.find((event) => event.type === 'session.tool.failed');
    expect(failed.data).toMatchObject({ id: 'call_w', error: { type: 'tool', message: 'The turn ended before this tool finished' }, executed: true });
    const [assistant] = await storedAssistants(id);
    expect(assistant.parts[0].state).toMatchObject({ status: 'error', input: PAGE_INPUT });
  });

  it('leaves a call that was only started alone, neither failed nor stored', async () => {
    const id = await createSession();
    await post(`/api/session/${id}/prompt`, { text: 'run a command' });
    await settle();

    expect(events.filter((event) => event.type.startsWith('session.tool.')).map((event) => event.type)).toEqual(['session.tool.input.started']);
    const [assistant] = await storedAssistants(id);
    expect(assistant.parts.map((part) => part.type)).toEqual(['text']);
  });

  it('ends a waiting call when the user writes, and answers both prompts in one turn', async () => {
    const id = await createSession();
    await post(`/api/session/${id}/prompt`, { text: 'wait on a page' });
    await settle();
    const before = toolServer.grants[0].userMessages;
    await post(`/api/session/${id}/prompt`, { text: 'written in the chat' });
    await settle();

    // Every prompt tells the tool server, which ends a wait if one runs.
    expect(toolServer.grants[0].userMessages).toBe(before + 1);
    expect(events.filter((event) => event.type === 'session.idle')).toHaveLength(1);
    const answers = await storedAssistants(id);
    expect(answers).toHaveLength(1);
    expect(answers[0].content).toBe('Read your message.');

    // The next prompt gets its own turn and its own answer.
    await post(`/api/session/${id}/prompt`, { text: 'three' });
    await settle();
    expect((await storedAssistants(id)).map((message) => message.content)).toEqual(['Read your message.', 'echo: three']);
  });
});

describe('toolServerEnvironment', () => {
  it.each([
    ['http://127.0.0.1:3901/api/openchamber/mcp', 'localhost', 'localhost,127.0.0.1'],
    ['http://[fd7a:115c::3]:3901/api/openchamber/mcp', undefined, 'fd7a:115c::3'],
    ['http://100.100.0.3:3901/api/openchamber/mcp', '100.100.0.3', '100.100.0.3'],
  ])('keeps %s away from an environment proxy and passes the rest through', (url, existing, expected) => {
    const env = { HOME: '/home/u', PATH: '/usr/bin' };
    if (existing !== undefined) Object.assign(env, { NO_PROXY: existing, no_proxy: existing });
    expect(toolServerEnvironment(url, env)).toEqual({ HOME: '/home/u', PATH: '/usr/bin', NO_PROXY: expected, no_proxy: expected });
  });

  it('changes nothing for a value that is not a URL', () => {
    const env = { HOME: '/home/u' };
    expect(toolServerEnvironment('not a url', env)).toBe(env);
  });
});

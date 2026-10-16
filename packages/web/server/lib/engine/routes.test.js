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
import { createClaudeEngine } from './claude/adapter.js';
import { createCodexEngine } from './codex/adapter.js';
import { createFakeEngine } from './test/fake-engine.js';
import { createFakeCodexChild, readCodexTranscript } from './test/fake-codex.js';

const answer = (text, proc) => {
  if (text === 'needs approval') {
    proc.emit('permission.requested', { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } });
    return;
  }
  if (text === 'fail') {
    proc.emit('text.delta', { text: 'partial' });
    proc.emit('turn.completed', { outcome: 'failed', error: { type: 'error_during_execution', message: 'Model refused' } });
    return;
  }
  if (text === 'crash') {
    proc.isAlive = false;
    proc.emit('exit', { code: 1, signal: null });
    return;
  }
  if (text === 'start conversation') proc.emit('engine.state', { conversationId: 'conv-1' });
  proc.emit('reasoning.delta', { text: 'thinking' });
  proc.emit('text.delta', { text: `echo: ${text}` });
  proc.emit('turn.completed', { outcome: 'succeeded', usage: { input: 3, output: 5 } });
};

describe('engine routes', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let streamHub;
  let fake;
  let events;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-routes-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    streamHub = new StreamHub();
    events = [];
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push(event);
      broadcast(sessionId, event);
    };
    fake = createFakeEngine({ id: 'fake', reply: answer });
    const claude = createClaudeEngine({
      installer: fake.installer,
      authStatusProvider: async () => ({ loggedIn: true, email: 'test@example.com', subscriptionType: 'pro' }),
    });

    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([claude, fake]),
      store,
      controlBridge: new ControlBridge(),
      streamHub,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = async (url, { body, method = body ? 'POST' : 'GET' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('lists every registered engine with the first one as default', async () => {
    const res = await request('/api/engines');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('claude');
    expect(res.body.data.map((e) => e.engine)).toEqual(['claude', 'fake']);

    const fakeStatus = await request('/api/engines/fake/status');
    expect(fakeStatus.body.displayName).toBe('Fake fake');
    expect((await request('/api/engines/missing/status')).status).toBe(404);

    const fakeAuth = await request('/api/engines/fake/auth/status');
    expect(fakeAuth.body.email).toBe('fake@example.com');
    const defaultAuth = await request('/api/auth/status');
    expect(defaultAuth.body.email).toBe('test@example.com');
  });

  it('serves one provider and one agent per engine', async () => {
    const providers = await request('/api/provider');
    expect(providers.body.data.map((p) => p.id)).toEqual(['anthropic', 'fake-provider']);
    expect(providers.body.data[1].models.map((m) => m.id)).toEqual(['fast', 'slow']);

    const agents = await request('/api/agent');
    expect(agents.body.data.map((a) => a.id)).toEqual(['claude', 'fake']);
  });

  it('creates sessions on the default engine unless one is named', async () => {
    const plain = await request('/api/session', { body: { title: 'Default' } });
    expect(plain.status).toBe(200);
    expect(plain.body.data.engine).toBe('claude');
    expect(plain.body.data.model).toEqual({ providerID: 'anthropic', id: 'sonnet' });

    const named = await request('/api/session', { body: { title: 'Fake', engine: 'fake' } });
    expect(named.body.data.engine).toBe('fake');
    expect(named.body.data.model).toEqual({ providerID: 'fake-provider', id: 'fast' });

    const unknown = await request('/api/session', { body: { engine: 'nope' } });
    expect(unknown.status).toBe(400);
  });

  it('treats a stored session without an engine as a default-engine session', async () => {
    const legacy = await store.createSession({ title: 'Before engines', cwd: '/work' });
    const res = await request(`/api/session/${legacy.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.engine).toBe('claude');
  });

  it('keeps the engine of a session fixed', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}`, { method: 'PATCH', body: { engine: 'claude', title: 'Renamed' } });
    const res = await request(`/api/session/${id}`);
    expect(res.body.data.engine).toBe('fake');
    expect(res.body.data.title).toBe('Renamed');
  });

  it('runs a prompt on the session engine and persists the answer', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;

    const res = await request(`/api/session/${id}/prompt`, { body: { text: 'hello' } });
    expect(res.status).toBe(200);
    await settle();

    expect(fake.processes).toHaveLength(1);
    expect(fake.processes[0].options).toMatchObject({ sessionId: id, model: 'fast', permissionMode: 'ask' });
    const types = events.map((e) => e.type);
    expect(types).toContain('session.reasoning.delta');
    expect(types).toContain('session.text.delta');
    // The turn opens and closes with OpenCode's execution events, which the UI
    // and the host status map read as running and finished.
    expect(types.filter((type) => type.startsWith('session.execution.'))).toEqual(['session.execution.started', 'session.execution.succeeded']);
    expect(types.at(-1)).toBe('session.execution.succeeded');
    expect(types).not.toContain('session.idle');
    // The process stays alive for the next prompt, but nothing runs now.
    expect(fake.processes[0].isAlive).toBe(true);
    expect((await request('/api/session/active')).body.data[id]).toBeUndefined();
    const stepEnded = events.find((e) => e.type === 'session.step.ended');
    expect(stepEnded.data.tokens.output).toBe(5);

    const messages = await request(`/api/session/${id}/message`);
    expect(messages.body.data.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = messages.body.data[1];
    expect(assistant.id).toBe(res.body.data.id);
    expect(assistant.providerID).toBe('fake-provider');
    expect(assistant.parts.map((p) => [p.type, p.text])).toEqual([['reasoning', 'thinking'], ['text', 'echo: hello']]);
  });

  it('gives each prompt on a live process its own assistant message', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    const first = await request(`/api/session/${id}/prompt`, { body: { text: 'one' } });
    await settle();
    const second = await request(`/api/session/${id}/prompt`, { body: { text: 'two' } });
    await settle();

    expect(fake.processes).toHaveLength(1);
    expect(first.body.data.id).not.toBe(second.body.data.id);
    const messages = (await request(`/api/session/${id}/message`)).body.data;
    const answers = messages.filter((m) => m.role === 'assistant').map((m) => m.parts.at(-1).text);
    expect(answers).toEqual(['echo: one', 'echo: two']);
  });

  it('keeps the engine state a process reports for the next process of the session', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'start conversation' } });
    await settle();
    expect((await store.getSession(id)).engineState).toEqual({ conversationId: 'conv-1' });

    await request(`/api/session/${id}`, { method: 'PATCH', body: { engineState: { conversationId: 'other' } } });
    expect((await store.getSession(id)).engineState).toEqual({ conversationId: 'conv-1' });

    await request(`/api/session/${id}/abort`, { body: {} });
    await request(`/api/session/${id}/prompt`, { body: { text: 'again' } });
    expect(fake.processes.map((p) => p.options.engineState)).toEqual([null, { conversationId: 'conv-1' }]);
  });

  it('answers with the manual step when an engine cannot install or sign in from the server', async () => {
    fake.installer.getStatus = () => ({ installed: false, state: 'idle', canInstall: false, installCommand: 'curl example | bash' });
    fake.auth.login = () => {
      throw new Error('Sign in from the CLI');
    };

    const install = await request('/api/engines/fake/install', { body: {} });
    expect(install.status).toBe(400);
    expect(install.body.installCommand).toBe('curl example | bash');
    expect((await request('/api/engines/fake/status')).body.installCommand).toBe('curl example | bash');

    const login = await request('/api/engines/fake/auth/login', { body: {} });
    expect(login.status).toBe(501);
    expect(login.body.error).toBe('Sign in from the CLI');
    expect((await request('/api/engines/fake/auth/logout', { body: {} })).body.success).toBe(true);
  });

  it('tells the next process to resume once a turn was answered', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'one' } });
    await settle();
    await request(`/api/session/${id}/abort`, { body: {} });
    await request(`/api/session/${id}/prompt`, { body: { text: 'two' } });
    await settle();

    expect(fake.processes.map((proc) => proc.options.resume)).toEqual([false, true]);
  });

  it('rejects a model or permission mode the engine does not know', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', model: 'sonnet' } })).status).toBe(400);
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', permissionMode: 'bypassPermissions' } })).status).toBe(400);
    expect((await request(`/api/session/${id}/model`, { body: { model: 'sonnet' } })).status).toBe(400);
    expect(fake.processes).toHaveLength(0);
  });

  it('moves an empty chat to the engine of the picked model and keeps a chat with history', async () => {
    const created = await request('/api/session', { body: { title: 'Picker' } });
    const id = created.body.data.id;
    expect(created.body.data.engine).toBe('claude');

    const moved = await request(`/api/session/${id}/model`, {
      body: { model: { providerID: 'fake-provider', id: 'slow', variant: 'none' } },
    });
    expect(moved.status).toBe(204);
    const after = (await request(`/api/session/${id}`)).body.data;
    expect(after.engine).toBe('fake');
    expect(after.model).toEqual({ providerID: 'fake-provider', id: 'slow' });
    expect(after.permissionMode).toBe('ask');

    await request(`/api/session/${id}/prompt`, { body: { text: 'hi' } });
    await settle();
    const back = await request(`/api/session/${id}/model`, { body: { model: { providerID: 'anthropic', id: 'opus' } } });
    expect(back.status).toBe(409);
    expect((await request(`/api/session/${id}`)).body.data.engine).toBe('fake');

    const sameEngine = await request(`/api/session/${id}/model`, { body: { model: { providerID: 'fake-provider', id: 'fast' } } });
    expect(sameEngine.status).toBe(204);
  });

  it('relays a permission request and the UI reply to the engine process', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs approval' } });
    await settle();
    expect(events.some((e) => e.type === 'permission.asked' && e.data.id === 'req-1')).toBe(true);

    const asked = events.find((e) => e.type === 'permission.asked');
    expect(asked.data).toMatchObject({ id: 'req-1', sessionID: id, action: 'Bash', resources: ['ls'] });
    const pending = await request(`/api/permission/request?directory=${encodeURIComponent(created.body.data.directory)}`);
    expect(pending.body.data.map((p) => p.id)).toEqual(['req-1']);

    const reply = await request(`/api/session/${id}/permission/req-1/reply`, { body: { decision: 'reject' } });
    expect(reply.status).toBe(204);
    await settle();
    expect(fake.processes[0].permissionReplies).toEqual([{ requestId: 'req-1', behavior: 'deny' }]);

    const again = await request(`/api/session/${id}/permission/req-1/reply`, { body: { decision: 'once' } });
    expect(again.status).toBe(404);
  });

  it('ends a running turn as interrupted on abort', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs approval' } });
    await settle();
    expect((await request('/api/session/active')).body.data[id]).toEqual({ type: 'running' });

    await request(`/api/session/${id}/abort`, { body: {} });
    const ended = events.filter((e) => e.type.startsWith('session.execution.') && e.type !== 'session.execution.started');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ type: 'session.execution.interrupted', data: { sessionID: id, reason: 'user' } });
    expect((await request('/api/session/active')).body.data[id]).toBeUndefined();
  });

  it('settles a session nothing runs in when the client asks to stop it', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/abort`, { body: {} });
    expect(events.at(-1)).toMatchObject({ type: 'session.execution.interrupted', data: { sessionID: id, reason: 'user' } });
  });

  it('ends a turn the engine failed with the engine error', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'fail' } });
    await settle();

    expect(events.at(-1)).toMatchObject({
      type: 'session.execution.failed',
      data: { sessionID: id, error: { type: 'error_during_execution', message: 'Model refused' } },
    });
    expect(events.find((e) => e.type === 'session.step.ended').data.finish).toBe('failed');
    // The partial answer is kept.
    const messages = (await request(`/api/session/${id}/message`)).body.data;
    expect(messages.at(-1).parts.at(-1).text).toBe('partial');
  });

  it('fails the running turn when the engine process exits', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'crash' } });
    await settle();

    const failed = events.filter((e) => e.type === 'session.execution.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({ sessionID: id, error: { type: 'EngineExited' } });
    expect(failed[0].data.error.message).toContain('Fake fake');
    expect((await request('/api/session/active')).body.data[id]).toBeUndefined();
  });

  it('fails the execution it announced when the engine cannot start', async () => {
    fake.startError = new Error('binary missing');
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    const res = await request(`/api/session/${id}/prompt`, { body: { text: 'hello' } });
    expect(res.status).toBe(500);

    const lifecycle = events.filter((e) => e.type.startsWith('session.execution.'));
    expect(lifecycle.map((e) => e.type)).toEqual(['session.execution.started', 'session.execution.failed']);
    expect(lifecycle[1].data.error).toEqual({ type: 'EngineStartFailed', message: 'binary missing' });
  });

  it('announces a new session with its engine and model', async () => {
    const created = await request('/api/session', { body: { engine: 'fake', title: 'Hello' } });
    expect(events.find((e) => e.type === 'session.created')).toMatchObject({
      data: { sessionID: created.body.data.id, title: 'Hello', agent: 'fake', model: { providerID: 'fake-provider', id: 'fast' } },
    });
  });

  it('tells other clients when a session is deleted', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    expect((await request(`/api/session/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(events.at(-1)).toMatchObject({ type: 'session.deleted', data: { sessionID: id } });

    const before = events.length;
    await request(`/api/session/${id}`, { method: 'DELETE' });
    expect(events.length).toBe(before);
  });

  it('returns the page cursor the OpenCode client reads on lists', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const sessions = await request('/api/session?limit=50');
    expect(sessions.body.cursor).toEqual({ previous: null, next: null });
    const messages = await request(`/api/session/${created.body.data.id}/message`);
    expect(messages.body.cursor).toEqual({ previous: null, next: null });
  });

  it('answers the location reads of the directory bootstrap', async () => {
    const directory = '/repo/app dir';
    const headers = { 'x-opencode-directory': encodeURIComponent(directory) };
    const location = await (await fetch(`${baseUrl}/api/location`, { headers })).json();
    expect(location.directory).toBe(directory);
    expect(location.project.canonical).toBe(directory);

    for (const route of ['/api/form', '/api/shell', '/api/permission/request']) {
      const res = await request(`${route}?directory=${encodeURIComponent(directory)}`);
      expect(res.body).toEqual({ location: { directory }, data: [] });
    }
    const vcs = await request(`/api/vcs?directory=${encodeURIComponent(directory)}`);
    expect(vcs.body.data.branch).toEqual({});

    await request('/api/session', { body: { location: { directory } } });
    const projects = await request('/api/project');
    expect(projects.body.map((p) => p.canonical)).toEqual([directory]);
    expect(projects.body[0].id).toBe(location.project.id);
  });

  it('keeps the plural CRUD routes for stored records', async () => {
    const created = await request('/api/sessions', { body: { title: 'New Session', cwd: 'C:\\projects\\app' } });
    expect(created.status).toBe(201);
    expect(created.body.cwd).toBe('C:/projects/app');
    const id = created.body.id;
    expect((await request('/api/sessions')).body.map((s) => s.id)).toEqual([id]);
    expect((await request(`/api/sessions/${id}`, { method: 'DELETE' })).body.success).toBe(true);
    expect((await request(`/api/sessions/${id}`)).status).toBe(404);
  });

  it('reports default-engine compatibility for the install gate', async () => {
    const res = await request('/api/codecli/compatibility');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('compatible');
    expect(res.body.version).toBe('1.0.0');
  });
});

describe('codex engine routes', () => {
  const CODEX_THREAD = '01a14700-0000-7000-8000-000000000001';
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let codex;
  let spawns;
  let transcripts;
  let enterprise;
  let events;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codex-routes-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    const streamHub = new StreamHub();
    events = [];
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push(event);
      broadcast(sessionId, event);
    };
    spawns = [];
    transcripts = [];
    enterprise = false;
    const installer = createFakeEngine().installer;
    codex = createCodexEngine({
      installer,
      spawnProcess: (args, options) => {
        const child = createFakeCodexChild(transcripts.shift());
        spawns.push({ args, options, child });
        return child;
      },
    });
    const claude = createClaudeEngine({ installer, authStatusProvider: async () => ({ loggedIn: true }) });

    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([claude, codex]),
      store,
      controlBridge: new ControlBridge(),
      streamHub,
      isEnterpriseMode: () => enterprise,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = async (url, { body, method = body ? 'POST' : 'GET' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting');
  };

  const pendingPermissions = async () => (await request('/api/permission/request?directory=%2Fwork%2Fapp')).body.data;

  it('runs a codex session through the app-server and resumes its thread in the next process', async () => {
    transcripts.push(readCodexTranscript('turn-with-tools'), readCodexTranscript('resume-turn'));
    const created = await request('/api/session', { body: { engine: 'codex', location: { directory: '/work/app' } } });
    expect(created.body.data.model).toEqual({ providerID: 'openai', id: 'gpt-6.1-sol' });
    const id = created.body.data.id;

    const prompt = await request(`/api/session/${id}/prompt`, { body: { text: 'The add helper returns the wrong sum. Fix it.' } });
    expect(prompt.status).toBe(200);
    expect(spawns.map(({ args, options }) => ({ args, options }))).toEqual([{ args: ['app-server'], options: { cwd: '/work/app' } }]);

    // The user allows the command, then rejects the edit.
    const [command] = await waitFor(async () => {
      const pending = await pendingPermissions();
      return pending.length === 1 && pending;
    });
    expect(command).toMatchObject({ action: 'shell', resources: ["/bin/bash -lc 'npm test'"] });
    expect((await request(`/api/session/${id}/permission/${command.id}/reply`, { body: { decision: 'once' } })).status).toBe(204);
    const [edit] = await waitFor(async () => {
      const pending = await pendingPermissions();
      return pending.length === 1 && pending[0].id !== command.id && pending;
    });
    expect(edit).toMatchObject({ action: 'edit', resources: ['/work/app/src/math.js'] });
    expect((await request(`/api/session/${id}/permission/${edit.id}/reply`, { body: { decision: 'reject' } })).status).toBe(204);
    await waitFor(() => events.some((event) => event.type === 'session.execution.succeeded'));

    const [first] = spawns;
    const sent = (method) => first.child.sent.find((message) => message.method === method);
    expect(sent('thread/start').params).toEqual({ cwd: '/work/app', model: 'gpt-6.1-sol', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(sent('turn/start').params.effort).toBe('medium');
    expect(first.child.sent.filter((message) => message.result).map((message) => message.result.decision)).toEqual(['accept', 'decline']);

    const stepEnded = events.find((event) => event.type === 'session.step.ended');
    expect(stepEnded.data.tokens).toEqual({ input: 15500, output: 280, reasoning: 250, cache: { read: 23500, write: 0 } });
    const messages = (await request(`/api/session/${id}/message`)).body.data;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1].providerID).toBe('openai');
    expect(messages[1].parts.at(-1).text).toBe(
      "I'll run the tests first.\n\nThe fix is to return `a + b` in src/math.js. I left the file unchanged because the edit was declined.",
    );
    expect((await store.getSession(id)).engineState).toEqual({ threadId: CODEX_THREAD });

    // A new process for the same session resumes the stored thread.
    await request(`/api/session/${id}/abort`, { body: {} });
    await request(`/api/session/${id}/prompt`, { body: { text: 'Apply it now.', permissionMode: 'never' } });
    await waitFor(() => events.filter((event) => event.type === 'session.execution.succeeded').length === 2);
    expect(spawns).toHaveLength(2);
    const resume = spawns[1].child.sent.find((message) => message.method === 'thread/resume');
    expect(resume.params).toMatchObject({ threadId: CODEX_THREAD, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: true });
  });

  it('rejects a permission mode Codex does not have before starting a process', async () => {
    const created = await request('/api/session', { body: { engine: 'codex', location: { directory: '/work/app' } } });
    const res = await request(`/api/session/${created.body.data.id}/prompt`, { body: { text: 'x', permissionMode: 'bypassPermissions' } });
    expect(res.status).toBe(400);
    expect(spawns).toHaveLength(0);
  });

  it('refuses signing in to an engine in enterprise mode but still signs out', async () => {
    let logins = 0;
    let logouts = 0;
    codex.auth.login = () => {
      logins += 1;
    };
    codex.auth.logout = async () => {
      logouts += 1;
    };

    expect((await request('/api/engines/codex/auth/login', { body: {} })).status).toBe(200);
    enterprise = true;
    const refused = await request('/api/engines/codex/auth/login', { body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('enterprise_mode');
    expect((await request('/api/auth/login', { body: {} })).status).toBe(403);
    expect(logins).toBe(1);

    expect((await request('/api/engines/codex/auth/logout', { body: {} })).body.success).toBe(true);
    expect(logouts).toBe(1);
  });
});

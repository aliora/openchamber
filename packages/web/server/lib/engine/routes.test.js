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
import { createFakeEngine } from './test/fake-engine.js';

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

  it('rejects a model or permission mode the engine does not know', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', model: 'sonnet' } })).status).toBe(400);
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', permissionMode: 'bypassPermissions' } })).status).toBe(400);
    expect((await request(`/api/session/${id}/model`, { body: { model: 'sonnet' } })).status).toBe(400);
    expect(fake.processes).toHaveLength(0);
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

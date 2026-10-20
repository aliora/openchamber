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
import { createFakeSpawn } from './test/fake-cli.js';
import { CliInstaller } from './cli-installer.js';
import { createModelCatalog, modelCatalogMethods } from './model-catalog.js';

const createFakeLoginPty = () => {
  const listeners = { data: [], exit: [] };
  return {
    pid: 0,
    written: [],
    killed: false,
    onData(listener) { listeners.data.push(listener); },
    onExit(listener) { listeners.exit.push(listener); },
    write(data) { this.written.push(data); },
    kill() { this.killed = true; },
    print(text) { for (const listener of listeners.data) listener(text); },
  };
};

const answer = (text, proc) => {
  if (text === 'needs approval') {
    proc.emit('permission.requested', { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } });
    return;
  }
  if (text === 'needs two approvals') {
    proc.emit('permission.requested', { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } });
    proc.emit('permission.requested', { requestId: 'req-2', toolName: 'Write', input: { file_path: 'a.txt' } });
    return;
  }
  if (text === 'needs input') {
    proc.emit('question.requested', {
      requestId: 'qst-1',
      title: 'Color question',
      questions: [{ id: 'q0', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiple: false, custom: true }],
    });
    return;
  }
  if (text === 'fail') {
    proc.emit('text.delta', { text: 'partial' });
    proc.emit('turn.completed', { outcome: 'failed', error: { type: 'error_during_execution', message: 'Model refused' } });
    return;
  }
  if (text === 'refuse') {
    proc.emit('turn.completed', { outcome: 'failed', error: { type: 'PermissionDenied', message: 'Command needs approval' } });
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
  let controlBridge;
  let loginPtys;
  let generated;
  let generateReply;
  let engineRoutes;

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
    // `ask` switches a running process, like Claude's modes; `yolo` waits
    // for the next process, like Claude's bypass.
    fake = createFakeEngine({ id: 'fake', reply: answer, livePermissionModes: ['ask'] });
    const claude = createClaudeEngine({
      installer: fake.installer,
      authStatusProvider: async () => ({ loggedIn: true, email: 'test@example.com', subscriptionType: 'pro' }),
    });

    const app = express();
    app.use(express.json());
    controlBridge = new ControlBridge();
    loginPtys = [];
    generated = [];
    generateReply = async () => 'Generated title';
    engineRoutes = registerEngineRoutes(app, {
      registry: createEngineRegistry([claude, fake]),
      store,
      controlBridge,
      streamHub,
      generateText: async (input) => {
        generated.push(input);
        return generateReply(input);
      },
      login: {
        spawnPty: async (command, args) => {
          const pty = Object.assign(createFakeLoginPty(), { command, args });
          loginPtys.push(pty);
          return pty;
        },
        pollMs: 5,
        enterDelayMs: 0,
      },
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
  const until = async (check) => {
    for (let attempt = 0; attempt < 100 && !(await check()); attempt += 1) await settle();
  };

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
    const models = await request('/api/model');
    expect(models.body.data.filter((m) => m.providerID === 'fake-provider').map((m) => m.id)).toEqual(['fast', 'slow']);

    const agents = await request('/api/agent');
    expect(agents.body.data.map((a) => a.id)).toEqual(['claude', 'fake']);
  });

  it('serves an empty integration list, since each CLI signs in on its own', async () => {
    const integrations = await request('/api/integration');
    expect(integrations.status).toBe(200);
    expect(integrations.body.data).toEqual([]);
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
    const created = await request('/api/session', { body: { engine: 'fake', title: 'Titled' } });
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

    const messages = await request(`/api/session/${id}/message?order=asc`);
    expect(messages.body.data.map((m) => m.type)).toEqual(['user', 'assistant']);
    const assistant = messages.body.data[1];
    expect(assistant.id).toBe(res.body.data.id);
    expect(assistant.model).toEqual({ providerID: 'fake-provider', id: 'fast' });
    expect(assistant.content.map((item) => [item.type, item.text])).toEqual([['reasoning', 'thinking'], ['text', 'echo: hello']]);
  });

  it('delivers synthetic context as background before the next prompt text', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;

    expect((await request(`/api/session/${id}/synthetic`, { body: { text: 'context one', resume: false } })).status).toBe(200);
    expect((await request(`/api/session/${id}/synthetic`, { body: { text: 'context two', resume: false } })).status).toBe(200);
    expect((await request(`/api/session/${id}/synthetic`, { body: { text: '' } })).status).toBe(400);
    expect((await request('/api/session/missing/synthetic', { body: { text: 'lost' } })).status).toBe(404);

    await request(`/api/session/${id}/prompt`, { body: { text: 'question' } });
    await settle();
    await request(`/api/session/${id}/prompt`, { body: { text: 'follow-up' } });
    await settle();

    const messages = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    const answers = messages.filter((m) => m.type === 'assistant').map((m) => m.content.at(-1).text);
    expect(answers).toEqual(['echo: context one\n\ncontext two\n\nquestion', 'echo: follow-up']);
  });

  it('keeps synthetic context out of the user message and serves it as synthetic messages', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    const metadata = { openchamberContext: { kind: 'terminal', terminalId: 't1', terminalLabel: '$ ls', startLine: 1, endLine: 1, output: 'x' } };

    await request(`/api/session/${id}/synthetic`, { body: { id: 'msg_000000000001ctx', text: 'standing', resume: false } });
    await request(`/api/session/${id}/synthetic`, { body: { text: 'terminal block', metadata, description: 'Terminal', resume: false } });
    await request(`/api/session/${id}/prompt`, { body: { text: 'question' } });
    await settle();

    const enqueued = events.filter((e) => e.type === 'session.inbox.enqueued').map((e) => e.data.item.type);
    expect(enqueued).toEqual(['synthetic', 'synthetic', 'user']);
    const messages = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(messages.map((m) => m.type)).toEqual(['synthetic', 'synthetic', 'user', 'assistant']);
    expect(messages[0]).toMatchObject({ id: 'msg_000000000001ctx', text: 'standing' });
    expect(messages[1]).toMatchObject({ text: 'terminal block', description: 'Terminal', metadata });
    expect(messages[2].text).toBe('question');
    expect(messages[3].content.at(-1).text).toBe('echo: standing\n\nterminal block\n\nquestion');
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
    const messages = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    const answers = messages.filter((m) => m.type === 'assistant').map((m) => m.content.at(-1).text);
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
    fake.auth.loginCommand = 'fake login';

    const install = await request('/api/engines/fake/install', { body: {} });
    expect(install.status).toBe(400);
    expect(install.body.command).toBe('curl example | bash');
    expect((await request('/api/engines/fake/status')).body.installCommand).toBe('curl example | bash');

    const login = await request('/api/engines/fake/auth/login', { body: {} });
    expect(login.status).toBe(501);
    expect(login.body.error).toBe('Run `fake login` in a terminal on the server to sign in to Fake fake.');
    expect((await request('/api/engines/fake/auth/logout', { body: {} })).body.success).toBe(true);
  });

  it('signs in through a background CLI the UI drives', async () => {
    let signedIn = false;
    let modelRefreshes = 0;
    fake.auth.status = async () => ({ loggedIn: signedIn });
    fake.auth.loginProcess = () => ({ command: '/bin/fake', args: ['login'] });
    fake.refreshModelCatalog = async () => {
      modelRefreshes += 1;
    };

    expect((await request('/api/engines/fake/auth/login')).body.state).toBe('idle');
    expect((await request('/api/engines/fake/auth/login/input', { body: { text: 'x' } })).status).toBe(409);

    const started = await request('/api/engines/fake/auth/login', { body: {} });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ state: 'starting', url: null, needsInput: false });
    expect(loginPtys[0]).toMatchObject({ command: '/bin/fake', args: ['login'] });

    loginPtys[0].print('Visit https://sign.example/in?x=1\r\nPaste code here > ');
    expect((await request('/api/engines/fake/auth/login')).body).toMatchObject({ state: 'waiting', url: 'https://sign.example/in?x=1', needsInput: true });

    expect((await request('/api/engines/fake/auth/login/input', { body: { text: '  ' } })).status).toBe(400);
    expect((await request('/api/engines/fake/auth/login/input', { body: { text: ' code-123 ' } })).status).toBe(200);
    await until(() => loginPtys[0].written.length === 2);
    expect(loginPtys[0].written).toEqual(['code-123', '\r']);

    signedIn = true;
    await until(async () => (await request('/api/engines/fake/auth/login')).body.state === 'succeeded');
    expect(loginPtys[0].killed).toBe(true);
    expect(modelRefreshes).toBe(1);
  });

  it('cancels a sign-in', async () => {
    fake.auth.status = async () => ({ loggedIn: false });
    fake.auth.loginProcess = () => ({ command: '/bin/fake', args: [] });
    await request('/api/engines/fake/auth/login', { body: {} });

    const cancelled = await request('/api/engines/fake/auth/login', { method: 'DELETE' });
    expect(cancelled.body.state).toBe('cancelled');
    expect(loginPtys[0].killed).toBe(true);
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

  it('keeps running a chat on its stored model after the engine stopped listing it', async () => {
    const created = await request('/api/session', { body: { engine: 'fake', model: { providerID: 'fake-provider', id: 'slow' } } });
    const id = created.body.data.id;
    fake.modelCatalog = () => ({ models: [{ id: 'fast', name: 'Fast' }], defaultModel: 'fast' });

    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'stored' } })).status).toBe(200);
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'same', model: 'slow' } })).status).toBe(200);
    await settle();
    expect(fake.processes.map((proc) => proc.options.model)).toEqual(['slow']);

    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', model: 'gone' } })).status).toBe(400);
    expect((await request(`/api/session/${id}`, { method: 'PATCH', body: { model: 'slow' } })).body.field).toBe('model');
  });

  it('lists what the composer offers for each engine without running a CLI', async () => {
    fake.installer.getStatus = () => {
      throw new Error('the controls must not check the CLI');
    };
    const res = await request('/api/engines/controls');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('claude');
    const [claude, fakeControls] = res.body.data;
    expect(claude).toMatchObject({ engine: 'claude', providerID: 'anthropic', defaultPermissionMode: 'auto', defaultEffort: 'medium' });
    expect(claude.permissionModes.map((mode) => [mode.id, mode.dangerous, mode.appliesLive])).toEqual([
      ['manual', false, true],
      ['acceptEdits', false, true],
      ['plan', false, true],
      ['auto', false, true],
      ['dontAsk', false, true],
      ['bypassPermissions', true, false],
    ]);
    expect(claude.permissionModes[0]).toMatchObject({
      labelKey: 'engine.permissionMode.claude.manual.label',
      descriptionKey: 'engine.permissionMode.claude.manual.description',
    });
    expect(fakeControls).toMatchObject({ engine: 'fake', defaultPermissionMode: 'ask', defaultEffort: null });
  });

  it('refuses a permission mode, effort or model the session engine does not know', async () => {
    const created = await request('/api/session', { body: {} });
    const id = created.body.data.id;
    const patch = (body) => request(`/api/session/${id}`, { method: 'PATCH', body });

    const unknownMode = await patch({ permissionMode: 'ask' });
    expect(unknownMode.status).toBe(400);
    expect(unknownMode.body).toMatchObject({ _tag: 'InvalidRequestError', field: 'permissionMode' });
    expect((await patch({ effort: 'extreme' })).body.field).toBe('effort');
    expect((await patch({ model: 'fast' })).body.field).toBe('model');
    expect((await request(`/api/sessions/${id}`, { method: 'PATCH', body: { permissionMode: 'yolo' } })).status).toBe(400);
    const stored = await store.getSession(id);
    expect(stored).toMatchObject({ permissionMode: 'auto', effort: 'medium', model: 'sonnet' });

    expect((await patch({ permissionMode: 'plan', effort: 'high' })).status).toBe(204);
    expect(await store.getSession(id)).toMatchObject({ permissionMode: 'plan', effort: 'high' });
    expect((await request('/api/session/missing', { method: 'PATCH', body: { permissionMode: 'plan' } })).status).toBe(404);
  });

  it('switches the permission mode of a running process when the engine can', async () => {
    const created = await request('/api/session', { body: { engine: 'fake', permissionMode: 'yolo' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'one' } });
    await settle();
    expect(fake.processes[0].options.permissionMode).toBe('yolo');

    expect((await request(`/api/session/${id}`, { method: 'PATCH', body: { permissionMode: 'ask' } })).status).toBe(204);
    expect(fake.processes[0].permissionModeChanges).toEqual(['ask']);

    // The process already runs in that mode, so the next prompt keeps it.
    await request(`/api/session/${id}/prompt`, { body: { text: 'two' } });
    await settle();
    expect(fake.processes).toHaveLength(1);
  });

  it('starts the next process in a mode the running one cannot switch to', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'one' } });
    await settle();

    await request(`/api/session/${id}`, { method: 'PATCH', body: { permissionMode: 'yolo' } });
    expect(fake.processes[0].permissionModeChanges).toEqual([]);
    expect(fake.processes[0].isAlive).toBe(true);

    await request(`/api/session/${id}/prompt`, { body: { text: 'two' } });
    await settle();
    expect(fake.processes.map((proc) => [proc.options.permissionMode, proc.options.resume])).toEqual([['ask', false], ['yolo', true]]);
    expect(fake.processes[0].isAlive).toBe(false);
    // Stopping the idle process announced nothing: one execution per prompt.
    expect(events.filter((e) => e.type === 'session.execution.succeeded')).toHaveLength(2);
    expect(events.some((e) => e.type === 'session.execution.interrupted')).toBe(false);
    const answers = (await request(`/api/session/${id}/message?order=asc`)).body.data.filter((m) => m.type === 'assistant');
    expect(answers.map((m) => m.content.at(-1).text)).toEqual(['echo: one', 'echo: two']);
  });

  it('keeps the old mode until the next prompt when the CLI refuses the switch', async () => {
    const created = await request('/api/session', { body: { engine: 'fake', permissionMode: 'yolo' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'one' } });
    await settle();
    fake.permissionModeError = new Error('refused');

    expect((await request(`/api/session/${id}`, { method: 'PATCH', body: { permissionMode: 'ask' } })).status).toBe(204);
    await request(`/api/session/${id}/prompt`, { body: { text: 'two' } });
    await settle();
    expect(fake.processes.map((proc) => proc.options.permissionMode)).toEqual(['yolo', 'ask']);
  });

  it('leaves a process answering a turn alone until its queue drains', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs approval' } });
    await settle();
    await request(`/api/session/${id}`, { method: 'PATCH', body: { permissionMode: 'yolo' } });

    await request(`/api/session/${id}/prompt`, { body: { text: 'queued' } });
    await settle();
    expect(fake.processes).toHaveLength(1);
    expect(fake.processes[0].sent).toEqual(['needs approval', 'queued']);
    await request(`/api/session/${id}/abort`, { body: {} });
  });

  it('starts a session on the engine and effort of the model it names', async () => {
    const created = await request('/api/session', {
      body: { model: { providerID: 'anthropic', id: 'opus', variant: 'high' }, location: { directory: '/work' } },
    });
    expect(created.status).toBe(200);
    expect(created.body.data.model).toEqual({ providerID: 'anthropic', id: 'opus', variant: 'high' });
    expect(await store.getSession(created.body.data.id)).toMatchObject({ engine: 'claude', model: 'opus', effort: 'high', permissionMode: 'auto' });

    const onFake = await request('/api/session', { body: { model: { providerID: 'fake-provider', id: 'slow' } } });
    expect(onFake.body.data).toMatchObject({ engine: 'fake', model: { providerID: 'fake-provider', id: 'slow' } });

    const unknownMode = await request('/api/session', { body: { model: { providerID: 'fake-provider', id: 'slow' }, permissionMode: 'plan' } });
    expect(unknownMode.status).toBe(400);
    expect(unknownMode.body.field).toBe('permissionMode');
  });

  it('reports a session effort other than the model default as its variant', async () => {
    const created = await request('/api/session', { body: {} });
    const id = created.body.data.id;
    expect(created.body.data.model).toEqual({ providerID: 'anthropic', id: 'sonnet' });
    await request(`/api/session/${id}/model`, { body: { model: { providerID: 'anthropic', id: 'sonnet', variant: 'max' } } });
    expect((await request(`/api/session/${id}`)).body.data.model).toEqual({ providerID: 'anthropic', id: 'sonnet', variant: 'max' });

    await request(`/api/session/${id}/model`, { body: { model: { providerID: 'anthropic', id: 'sonnet', variant: 'medium' } } });
    expect((await request(`/api/session/${id}`)).body.data.model).toEqual({ providerID: 'anthropic', id: 'sonnet' });
  });

  it('moves a chat to the engine of the picked model and marks one with history for handoff', async () => {
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
    const sameEngine = await request(`/api/session/${id}/model`, { body: { model: { providerID: 'fake-provider', id: 'fast' } } });
    expect(sameEngine.status).toBe(204);
    expect((await store.getSession(id)).handoff).toBeUndefined();

    const back = await request(`/api/session/${id}/model`, { body: { model: { providerID: 'anthropic', id: 'opus' } } });
    expect(back.status).toBe(204);
    expect(await store.getSession(id)).toMatchObject({ engine: 'claude', model: 'opus', engineState: null, handoff: true });

    const patched = await request(`/api/session/${id}`, { method: 'PATCH', body: { handoff: false } });
    expect(patched.status).toBe(204);
    expect((await store.getSession(id)).handoff).toBe(true);
  });

  it('carries full permission to the engine of the picked model', async () => {
    const created = await request('/api/session', { body: { permissionMode: 'bypassPermissions' } });
    const id = created.body.data.id;

    await request(`/api/session/${id}/model`, { body: { model: { providerID: 'fake-provider', id: 'slow' } } });
    expect(await store.getSession(id)).toMatchObject({ engine: 'fake', permissionMode: 'yolo' });

    await request(`/api/session/${id}/model`, { body: { model: { providerID: 'anthropic', id: 'opus' } } });
    expect(await store.getSession(id)).toMatchObject({ engine: 'claude', permissionMode: 'bypassPermissions' });
  });

  it('starts a sub-session in its parent mode, mapped by tier onto another engine', async () => {
    const parent = (await request('/api/session', { body: { permissionMode: 'acceptEdits' } })).body.data;
    const sameEngine = (await request('/api/session', { body: { parentID: parent.id } })).body.data;
    expect(sameEngine.permissionMode).toBe('acceptEdits');

    const otherEngine = (await request('/api/session', { body: { parentID: parent.id, engine: 'fake' } })).body.data;
    expect(otherEngine.permissionMode).toBe('ask');

    const fullParent = (await request('/api/session', { body: { engine: 'fake', permissionMode: 'yolo' } })).body.data;
    const fullChild = (await request('/api/session', { body: { parentID: fullParent.id } })).body.data;
    expect(fullChild.permissionMode).toBe('bypassPermissions');

    const explicit = (await request('/api/session', { body: { parentID: parent.id, permissionMode: 'plan' } })).body.data;
    expect(explicit.permissionMode).toBe('plan');
    const orphan = (await request('/api/session', { body: { parentID: 'missing' } })).body.data;
    expect(orphan.permissionMode).toBe('auto');
  });

  it('moves a sub-session to another engine without raising its tier', async () => {
    const parent = (await request('/api/session', { body: { permissionMode: 'plan' } })).body.data;
    const child = (await request('/api/session', { body: { parentID: parent.id } })).body.data;
    await request(`/api/session/${child.id}/model`, { body: { model: { providerID: 'fake-provider', id: 'slow' } } });
    expect(await store.getSession(child.id)).toMatchObject({ engine: 'fake', permissionMode: 'ask' });

    await store.updateSession(child.id, { permissionMode: 'ask' });
    await request(`/api/session/${child.id}/model`, { body: { model: { providerID: 'anthropic', id: 'opus' } } });
    expect(await store.getSession(child.id)).toMatchObject({ engine: 'claude', permissionMode: 'manual' });
  });

  it('lets an agent change a sub-session mode through the same path as the composer', async () => {
    const caller = (await request('/api/session', { body: { engine: 'fake', permissionMode: 'yolo' } })).body.data;
    const child = (await request('/api/session', { body: { engine: 'fake', parentID: caller.id, permissionMode: 'yolo' } })).body.data;
    await request(`/api/session/${child.id}/prompt`, { body: { text: 'hi' } });
    await settle();

    expect(await engineRoutes.agentPermissions.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'ask' }))
      .toEqual({ sessionId: child.id, permissionMode: 'ask' });
    expect(fake.processes[0].permissionModeChanges).toEqual(['ask']);
    expect(await store.getSession(child.id)).toMatchObject({ permissionMode: 'ask' });
    expect(await store.getSession(caller.id)).toMatchObject({ permissionMode: 'yolo' });
  });

  it('changes a sub-session on the user route without touching its parent or the parent its children', async () => {
    const parent = (await request('/api/session', { body: { permissionMode: 'manual' } })).body.data;
    const child = (await request('/api/session', { body: { parentID: parent.id } })).body.data;

    expect((await request(`/api/session/${child.id}`, { method: 'PATCH', body: { permissionMode: 'bypassPermissions' } })).status).toBe(204);
    expect((await request(`/api/session/${parent.id}`, { method: 'PATCH', body: { permissionMode: 'plan' } })).status).toBe(204);
    expect(await store.getSession(child.id)).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(await store.getSession(parent.id)).toMatchObject({ permissionMode: 'plan' });
  });

  it('runs a session stored with a mode its engine no longer offers in the engine default', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await store.updateSession(id, { permissionMode: 'auto' });

    expect((await request(`/api/sessions/${id}`)).body.permissionMode).toBe('ask');
    expect((await store.getSession(id)).permissionMode).toBe('ask');

    await store.updateSession(id, { permissionMode: 'auto' });
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'hi' } })).status).toBe(200);
    await settle();
    expect(fake.processes[0].options.permissionMode).toBe('ask');
    expect((await store.getSession(id)).permissionMode).toBe('ask');
  });

  it('keeps a stored mode that the engine lists once its permission mode probe finished', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await store.updateSession(id, { permissionMode: 'auto' });
    fake.startPermissionModeProbe = async () => {
      fake.permissionModes = ['ask', 'auto', 'yolo'];
    };

    expect((await request(`/api/sessions/${id}`)).body.permissionMode).toBe('auto');
    expect((await store.getSession(id)).permissionMode).toBe('auto');
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

  it('shows a question as a form, lists it and hands the answer to the engine process', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    const formsOf = async () => (await request(`/api/form?directory=${encodeURIComponent(created.body.data.directory)}`)).body.data;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs input' } });
    await settle();

    const asked = events.find((e) => e.type === 'form.created');
    expect(asked.data.form).toEqual({
      id: 'qst-1',
      sessionID: id,
      title: 'Color question',
      fields: [{
        key: 'q0',
        type: 'string',
        title: 'Which color?',
        required: true,
        options: [{ value: 'Red', label: 'Red' }, { value: 'Blue', label: 'Blue' }],
        custom: true,
      }],
    });
    expect((await formsOf()).map((form) => form.id)).toEqual(['qst-1']);

    expect((await request(`/api/session/${id}/form/qst-1/reply`, { body: { answer: { q0: { pick: 'Blue' } } } })).status).toBe(400);
    expect((await request(`/api/session/${id}/form/qst-1/reply`, { body: { answer: { q0: 'Blue' } } })).status).toBe(204);
    await settle();
    expect(fake.processes[0].questionReplies).toEqual([{ requestId: 'qst-1', answers: { q0: ['Blue'] } }]);
    expect(events.find((e) => e.type === 'form.replied').data).toEqual({ id: 'qst-1', sessionID: id, answer: { q0: 'Blue' } });
    expect(await formsOf()).toEqual([]);

    const again = await request(`/api/session/${id}/form/qst-1/reply`, { body: { answer: { q0: 'Red' } } });
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ _tag: 'FormNotFoundError', formID: 'qst-1' });
  });

  it('tells the engine a dismissed question has no answer and drops the question of a stopped turn', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs input' } });
    await settle();

    expect((await request(`/api/session/${id}/form/qst-1`, { method: 'DELETE' })).status).toBe(204);
    await settle();
    expect(fake.processes[0].questionReplies).toEqual([{ requestId: 'qst-1', answers: null }]);
    expect(events.filter((e) => e.type === 'form.cancelled').map((e) => e.data)).toEqual([{ id: 'qst-1', sessionID: id }]);
    expect((await request(`/api/session/${id}/form/qst-1`, { method: 'DELETE' })).status).toBe(404);

    await request(`/api/session/${id}/abort`, { body: {} });
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs input' } });
    await settle();
    await request(`/api/session/${id}/abort`, { body: {} });
    await settle();
    expect(fake.processes[1].questionReplies).toEqual([]);
    expect(events.filter((e) => e.type === 'form.cancelled')).toHaveLength(2);
    expect(controlBridge.getPendingQuestions(id)).toEqual([]);
  });

  it('allows the rest of the chat when a request is always allowed', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs two approvals' } });
    await settle();
    expect(events.filter((e) => e.type === 'permission.asked').map((e) => e.data.save)).toEqual([['*'], ['*']]);

    const reply = await request(`/api/session/${id}/permission/req-1/reply`, { body: { decision: 'always' } });
    expect(reply.status).toBe(204);
    await settle();
    expect(events.filter((e) => e.type === 'permission.replied').map((e) => e.data)).toEqual([
      { sessionID: id, requestID: 'req-1' },
      { sessionID: id, requestID: 'req-2' },
    ]);

    fake.processes[0].emit('permission.requested', { requestId: 'req-3', toolName: 'Bash', input: { command: 'pwd' } });
    await settle();
    expect(events.filter((e) => e.type === 'permission.asked').map((e) => e.data.id)).toEqual(['req-1', 'req-2']);
    expect(fake.processes[0].permissionReplies).toEqual([
      { requestId: 'req-1', behavior: 'allow' },
      { requestId: 'req-2', behavior: 'allow' },
      { requestId: 'req-3', behavior: 'allow' },
    ]);
    expect((await request(`/api/session/${id}/permission/req-1/reply`, { body: { decision: 'always' } })).status).toBe(404);

    await request(`/api/session/${id}/abort`, { body: {} });
    await request(`/api/session/${id}/prompt`, { body: { text: 'needs approval' } });
    await settle();
    expect(fake.processes).toHaveLength(2);
    expect(fake.processes[1].permissionReplies).toEqual([{ requestId: 'req-1', behavior: 'allow' }]);
    expect(events.filter((e) => e.type === 'permission.asked')).toHaveLength(2);

    expect((await request(`/api/session/${id}`, { method: 'DELETE' })).status).toBe(204);
    void controlBridge.handleControlRequest(id, { requestId: 'req-after-delete' }, 'manual');
    expect(controlBridge.getPendingRequests(id).map((item) => item.requestId)).toEqual(['req-after-delete']);
    controlBridge.clearSession(id);
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
    const created = await request('/api/session', { body: { engine: 'fake', title: 'Titled' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'fail' } });
    await settle();

    expect(events.at(-1)).toMatchObject({
      type: 'session.execution.failed',
      data: { sessionID: id, error: { type: 'error_during_execution', message: 'Model refused' } },
    });
    // `error` is the v2 finish of a failed step, live and in history.
    expect(events.find((e) => e.type === 'session.step.ended').data.finish).toBe('error');
    // The partial answer is kept.
    const messages = (await request(`/api/session/${id}/message`)).body.data;
    const answer = messages.find((m) => m.type === 'assistant');
    expect(answer.finish).toBe('error');
    expect(answer.content.at(-1).text).toBe('partial');
  });

  it('keeps the error of a failed turn that produced nothing, so history shows why', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'refuse' } });
    await settle();

    const messages = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({ finish: 'error', content: [], error: { type: 'PermissionDenied', message: 'Command needs approval' } });
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

  it('keeps the session that started a new one as its parent, in the record and the announcement', async () => {
    const parent = await request('/api/session', { body: { engine: 'fake' } });
    const child = await request('/api/session', { body: { engine: 'fake', parentID: parent.body.data.id } });
    const id = child.body.data.id;

    expect((await request(`/api/session/${id}`)).body.data.parentID).toBe(parent.body.data.id);
    expect(events.find((e) => e.type === 'session.created' && e.data.sessionID === id).data.parentID).toBe(parent.body.data.id);
    expect('parentID' in parent.body.data).toBe(false);
  });

  it('serves and announces a session created without a title as untitled', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    // OpenCode's session `title` is optional; the UI shows its own placeholder without one.
    expect('title' in created.body.data).toBe(false);
    expect('title' in (await request(`/api/session/${id}`)).body.data).toBe(false);
    expect(events.find((e) => e.type === 'session.created' && e.data.sessionID === id).data.title).toBeUndefined();
  });

  it('titles an untitled session after its first prompt and tells every client', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'Why do titles stay untitled?' } });
    await until(async () => (await store.getSession(id)).title);

    expect((await request(`/api/session/${id}`)).body.data.title).toBe('Generated title');
    expect(events.find((e) => e.type === 'session.renamed')).toMatchObject({ data: { sessionID: id, title: 'Generated title' } });
    expect(generated).toHaveLength(1);
    expect(generated[0].adapter.id).toBe('fake');
    expect(generated[0].prompt).toContain('Why do titles stay untitled?');

    await request(`/api/session/${id}/prompt`, { body: { text: 'second' } });
    await until(async () => (await store.getMessages(id)).length === 4);
    await settle();
    expect(generated).toHaveLength(1);
    expect(events.filter((e) => e.type === 'session.renamed')).toHaveLength(1);
  });

  it('answers the prompt without waiting for the title', async () => {
    generateReply = () => new Promise(() => {});
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const res = await request(`/api/session/${created.body.data.id}/prompt`, { body: { text: 'slow title' } });
    expect(res.status).toBe(200);
    await until(async () => generated.length === 1);
    expect(generated).toHaveLength(1);
  });

  it('titles a session from its first message when the engine cannot', async () => {
    generateReply = async () => { throw new Error('Not logged in'); };
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'Oturum başlıkları neden hep boş kalıyor acaba söyler misin' } });
    await until(async () => (await store.getSession(id)).title);
    expect((await store.getSession(id)).title).toBe('Oturum başlıkları neden hep boş kalıyor acaba');
  });

  it('keeps a title the session was given', async () => {
    const created = await request('/api/session', { body: { engine: 'fake', title: 'Scheduled: nightly report' } });
    const id = created.body.data.id;
    await request(`/api/session/${id}/prompt`, { body: { text: 'run the report' } });
    await until(async () => (await store.getMessages(id)).length === 2);
    await settle();
    expect((await store.getSession(id)).title).toBe('Scheduled: nightly report');
    expect(generated).toHaveLength(0);
  });

  it('tells every client when a session is renamed', async () => {
    const created = await request('/api/session', { body: { engine: 'fake' } });
    const id = created.body.data.id;
    expect((await request(`/api/session/${id}`, { method: 'PATCH', body: { title: 'Picked by hand' } })).status).toBe(204);
    expect(events.at(-1)).toMatchObject({ type: 'session.renamed', data: { sessionID: id, title: 'Picked by hand' } });

    const before = events.length;
    await request(`/api/session/${id}`, { method: 'PATCH', body: { permissionMode: 'yolo' } });
    expect(events.slice(before).some((e) => e.type === 'session.renamed')).toBe(false);
  });

  it('answers a one-off prompt on the engine of the requested model', async () => {
    generateReply = async () => 'Short answer';
    const res = await request('/api/experimental/generate', { body: { prompt: 'Title this', model: { providerID: 'fake-provider', id: 'slow' } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { text: 'Short answer' } });
    expect(generated[0]).toMatchObject({ prompt: 'Title this', model: 'slow' });
    expect(generated[0].adapter.id).toBe('fake');

    await request('/api/experimental/generate', { body: { prompt: 'Default engine' } });
    expect(generated[1].adapter.id).toBe('claude');
    expect(generated[1].model).toBeUndefined();
  });

  it('refuses a one-off prompt it cannot route and reports an engine failure', async () => {
    expect((await request('/api/experimental/generate', { body: { prompt: '' } })).body._tag).toBe('InvalidRequestError');
    const unknownProvider = await request('/api/experimental/generate', { body: { prompt: 'x', model: { providerID: 'nope', id: 'fast' } } });
    expect(unknownProvider.status).toBe(400);
    const unknownModel = await request('/api/experimental/generate', { body: { prompt: 'x', model: { providerID: 'fake-provider', id: 'huge' } } });
    expect(unknownModel.status).toBe(400);
    expect(generated).toHaveLength(0);

    generateReply = async () => { throw new Error('Not logged in'); };
    const failed = await request('/api/experimental/generate', { body: { prompt: 'x', model: { providerID: 'fake-provider', id: 'fast' } } });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ _tag: 'ServiceUnavailableError', message: 'Not logged in' });
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
    // The client folds a bare list of config documents; a `data` envelope
    // failed every directory's bootstrap.
    const config = await request(`/api/config?directory=${encodeURIComponent(directory)}`);
    expect(config.body).toEqual([{ type: 'document', info: { model: 'anthropic/sonnet' } }]);

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

describe('engine actions', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let spawn;
  let detection;
  let cli;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-actions-routes-test-'));
    spawn = createFakeSpawn();
    detection = { installed: false, version: null, command: null };
    cli = createFakeEngine({ id: 'cli' });
    cli.installer = new CliInstaller(
      { packageName: '@example/cli', detect: () => detection, doctorArgs: ['doctor'] },
      { platform: 'linux', env: { HOME: tmpDir }, home: tmpDir, fileExists: () => false, fetchLatest: async () => '2.0.0', spawnProcess: spawn.spawnProcess },
    );
    cli.auth.loginCommand = 'cli login';
    cli.auth.logoutCommand = 'cli logout';
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([cli]),
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      controlBridge: new ControlBridge(),
      streamHub: new StreamHub(),
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
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

  it('lists where each CLI came from, what the server can run and the commands', async () => {
    detection = { installed: true, version: '1.0.0', command: '/prefix/bin/cli', managedByNpm: true };
    const engine = (await request('/api/engines')).body.data[0];
    expect(engine).toMatchObject({
      installSource: 'npm',
      actions: { install: true, update: true, uninstall: true, reinstall: true, doctor: true },
      commands: {
        install: 'npm install -g @example/cli@latest',
        update: 'npm install -g @example/cli@latest',
        uninstall: 'npm uninstall -g @example/cli',
        reinstall: 'npm install -g @example/cli@latest --force',
        doctor: '/prefix/bin/cli doctor',
        login: 'cli login',
        logout: 'cli logout',
      },
      action: null,
    });
  });

  it('starts an action, refuses a second one while it runs and reports it on the status', async () => {
    detection = { installed: true, version: '1.0.0', command: '/prefix/bin/cli', managedByNpm: true };
    const started = await request('/api/engines/cli/actions/update', {});
    expect(started).toEqual({ status: 202, body: { status: 'running', action: 'update', message: 'Fake cli update started' } });
    expect(spawn.calls[0].args).toEqual(['install', '-g', '@example/cli@latest']);

    const busy = await request('/api/engines/cli/actions/doctor', {});
    expect(busy.status).toBe(409);
    expect(busy.body.action).toBe('update');
    expect((await request('/api/engines/cli/status')).body).toMatchObject({ state: 'installing', action: 'update' });

    spawn.finish(0);
    await settle();
    expect((await request('/api/engines/cli/status')).body).toMatchObject({ state: 'completed', action: 'update' });
    expect(spawn.calls).toHaveLength(1);
  });

  it('answers 400 with the command for an action the server cannot run, and 404 for an unknown one', async () => {
    const refused = await request('/api/engines/cli/actions/uninstall', {});
    expect(refused).toEqual({ status: 400, body: { error: 'Fake cli cannot uninstall from OpenChamber', command: null } });
    expect((await request('/api/engines/cli/actions/format', {})).status).toBe(404);
    expect(spawn.calls).toHaveLength(0);
  });

  it('keeps the install route as the install action and checks readiness again when it ends', async () => {
    await request('/api/engines/readiness');
    await settle();
    expect((await request('/api/engines/readiness')).body.data[0].state).toBe('not-installed');

    const legacy = await request('/api/engines/cli/install', {});
    expect(legacy.status).toBe(202);
    expect(legacy.body.action).toBe('install');
    expect(spawn.calls[0].args).toEqual(['install', '-g', '@example/cli@latest']);

    detection = { installed: true, version: '2.0.0', command: '/prefix/bin/cli', managedByNpm: true };
    spawn.finish(0);
    await settle();
    expect((await request('/api/engines/readiness')).body.data[0].state).toBe('unknown');
    await settle();
    expect((await request('/api/engines/readiness')).body.data[0].state).toBe('ready');
  });

  it('passes removeConfig only to uninstall', async () => {
    detection = { installed: true, version: '1.0.0', command: '/prefix/bin/cli', managedByNpm: true };
    const runs = [];
    const runAction = cli.installer.runAction.bind(cli.installer);
    cli.installer.runAction = (action, options) => {
      runs.push([action, options]);
      return runAction(action, options);
    };
    expect((await request('/api/engines/cli/actions/uninstall', { removeConfig: true })).status).toBe(202);
    spawn.finish(0);
    await settle();
    expect(runs).toEqual([['uninstall', { removeConfig: true }]]);
  });

  it('answers a failed sign-out honestly and checks readiness again', async () => {
    let readinessChecks = 0;
    const authStatus = cli.auth.status;
    cli.auth.status = async () => {
      readinessChecks += 1;
      return authStatus();
    };
    detection = { installed: true, version: '1.0.0', command: '/prefix/bin/cli', managedByNpm: true };
    await request('/api/engines/readiness');
    await settle();
    expect(readinessChecks).toBe(1);

    cli.auth.logout = () => {
      throw new Error('cli logout exited with code 1');
    };
    const logout = await request('/api/engines/cli/auth/logout', {});
    expect(logout).toEqual({ status: 501, body: { error: 'cli logout exited with code 1' } });
    expect((await request('/api/engines/readiness')).body.data[0].state).toBe('unknown');
    await settle();
    expect(readinessChecks).toBe(2);
  });
});

describe('engine model list refresh', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let events;
  let lists;
  let fake;
  let other;

  const listedEngine = (id) => {
    const engine = createFakeEngine({ id });
    const catalog = createModelCatalog({
      id,
      fallback: engine.modelCatalog(),
      read: async () => {
        const next = lists[id].shift();
        if (next instanceof Error) throw next;
        return next;
      },
      identify: () => `${id} 1.0.0`,
      warn: () => {},
    });
    return Object.assign(engine, modelCatalogMethods(catalog));
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-model-refresh-test-'));
    events = [];
    lists = { fake: [], other: [] };
    fake = listedEngine('fake');
    other = listedEngine('other');
    const streamHub = new StreamHub();
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push([sessionId, event]);
      broadcast(sessionId, event);
    };
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([fake, other]),
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      controlBridge: new ControlBridge(),
      streamHub,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    lists.fake.push({ models: [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }], defaultModel: 'fast' });
    lists.other.push({ models: [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }], defaultModel: 'fast' });
    await Promise.all([fake.startModelCatalog(), other.startModelCatalog()]);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (url, body = {}) => {
    const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const modelIds = async () => (await (await fetch(`${baseUrl}/api/model`)).json()).data.map((model) => `${model.providerID}/${model.id}`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('reads one engine list again on request, serves it and tells the clients', async () => {
    lists.fake.push({ models: [{ id: 'turbo', name: 'Turbo', efforts: ['low'] }], defaultModel: 'gone' });

    const refreshed = await post('/api/engines/fake/models/refresh');
    expect(refreshed).toEqual({
      status: 200,
      body: { engine: 'fake', providerID: 'fake-provider', models: [{ id: 'turbo', name: 'Turbo', efforts: ['low'] }], defaultModel: 'turbo', error: null },
    });
    expect(await modelIds()).toEqual(['fake-provider/turbo', 'other-provider/fast', 'other-provider/slow']);
    expect(events).toEqual([['global', expect.objectContaining({ type: 'model.updated', data: { engine: 'fake' } })]]);
  });

  it('answers a failed read with the list it keeps serving', async () => {
    lists.fake.push(new Error('agy listed no models'));
    const refreshed = await post('/api/engines/fake/models/refresh');
    expect(refreshed.status).toBe(502);
    expect(refreshed.body).toMatchObject({ engine: 'fake', defaultModel: 'fast', error: 'agy listed no models' });
    expect(events).toEqual([]);
    expect((await post('/api/engines/missing/models/refresh')).status).toBe(404);
  });

  it('reads every engine list again on request', async () => {
    lists.fake.push({ models: [{ id: 'turbo', name: 'Turbo' }], defaultModel: 'turbo' });
    lists.other.push(new Error('timed out'));
    const refreshed = await post('/api/engines/models/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.map(({ engine, defaultModel, error }) => [engine, defaultModel, error])).toEqual([
      ['fake', 'turbo', null],
      ['other', 'fast', 'timed out'],
    ]);
  });

  it('reads the list again once a CLI job ends and after a sign-out', async () => {
    fake.installer.getStatus = () => ({ installed: true, version: '1.0.0', state: 'idle', canInstall: true, actions: { update: true } });
    let finishJob;
    fake.installer.runAction = () => new Promise((resolve) => { finishJob = resolve; });
    lists.fake.push({ models: [{ id: 'after-update', name: 'After update' }], defaultModel: 'after-update' });
    lists.fake.push({ models: [{ id: 'after-logout', name: 'After logout' }], defaultModel: 'after-logout' });

    expect((await post('/api/engines/fake/actions/update')).status).toBe(202);
    await settle();
    expect(fake.modelCatalog().defaultModel).toBe('fast');
    finishJob();
    await settle();
    expect(fake.modelCatalog().defaultModel).toBe('after-update');

    expect((await post('/api/engines/fake/auth/logout')).status).toBe(200);
    await settle();
    expect(fake.modelCatalog().defaultModel).toBe('after-logout');
  });
});

describe('install gate compatibility', () => {
  let server;
  let tmpDir;
  let claudeInstaller;
  let otherInstaller;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compat-routes-test-'));
    claudeInstaller = createFakeEngine().installer;
    const claude = createClaudeEngine({ installer: claudeInstaller, authStatusProvider: async () => ({ loggedIn: true }) });
    const other = createFakeEngine({ id: 'other' });
    otherInstaller = other.installer;
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([claude, other]),
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      controlBridge: new ControlBridge(),
      streamHub: new StreamHub(),
    });
    server = app.listen(0);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const compatibility = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/codecli/compatibility`)).json();
  const missing = () => ({ installed: false, state: 'idle', canInstall: true });

  it('is compatible when only another engine CLI is installed', async () => {
    claudeInstaller.getStatus = missing;
    otherInstaller.getStatus = () => ({ installed: true, version: '3.0.0', command: 'other', state: 'idle', canInstall: true });
    expect(await compatibility()).toMatchObject({ state: 'compatible', version: '3.0.0' });
  });

  it('is incompatible only when no engine CLI is installed', async () => {
    claudeInstaller.getStatus = missing;
    otherInstaller.getStatus = missing;
    expect(await compatibility()).toMatchObject({ state: 'incompatible', version: null });
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
  let loginPtys;
  // What the fake CLI answers to `model/list`, once a test starts the read.
  let cliModels;

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
    loginPtys = [];
    cliModels = null;
    const installer = createFakeEngine().installer;
    codex = createCodexEngine({
      installer,
      readModels: async () => cliModels,
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
      login: {
        spawnPty: async () => {
          const pty = createFakeLoginPty();
          loginPtys.push(pty);
          return pty;
        },
      },
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
    expect(sent('thread/start').params).toEqual({
      cwd: '/work/app',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: { features: { default_mode_request_user_input: true } },
    });
    expect(sent('turn/start').params.effort).toBe('medium');
    expect(first.child.sent.filter((message) => message.result).map((message) => message.result.decision)).toEqual(['accept', 'decline']);

    const stepEnded = events.find((event) => event.type === 'session.step.ended');
    expect(stepEnded.data.tokens).toEqual({ input: 15500, output: 280, reasoning: 250, cache: { read: 23500, write: 0 }, total: 14080 });
    const messages = (await request(`/api/session/${id}/message?order=asc`)).body.data;
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant']);
    expect(messages[1].model.providerID).toBe('openai');
    // Parts keep the order they streamed in. The command and the edit were
    // only started (Codex reports nothing more about them), so they are not kept.
    // Each answer Codex wrote around the calls is a text part of its own.
    expect(messages[1].content.map((item) => item.type)).toEqual(['reasoning', 'text', 'tool', 'text']);
    expect(messages[1].content[2]).toMatchObject({ id: 'call_docs_search', name: 'mcp__docs__search', state: { status: 'completed' } });
    expect(messages[1].content[1].text).toBe("I'll run the tests first.");
    expect(messages[1].content[3].text).toBe('The fix is to return `a + b` in src/math.js. I left the file unchanged because the edit was declined.');
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

  it('offers and accepts the models and efforts the CLI listed', async () => {
    // A newer Codex: one model only it knows, and one that offers fewer efforts.
    cliModels = {
      models: [
        { id: 'gpt-7-nova', name: 'GPT-7-Nova', efforts: ['low', 'medium', 'high', 'max', 'ultra'] },
        { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
      ],
      defaultModel: 'gpt-7-nova',
    };
    await codex.startModelCatalog();

    const listed = (await request('/api/model')).body.data.filter((model) => model.providerID === 'openai');
    expect(listed.map((model) => [model.id, model.name, model.variants.map((variant) => variant.id)])).toEqual([
      ['gpt-7-nova', 'GPT-7-Nova', ['low', 'medium', 'high', 'max', 'ultra']],
      ['gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high', 'xhigh']],
    ]);

    // A new chat starts on the model the CLI names as its default.
    const created = await request('/api/session', { body: { engine: 'codex', location: { directory: '/work/app' } } });
    expect(created.body.data.model).toEqual({ providerID: 'openai', id: 'gpt-7-nova' });
    const id = created.body.data.id;
    const pick = (model) => request(`/api/session/${id}/model`, { body: { model: { providerID: 'openai', ...model } } });

    // A model of the fallback list the CLI no longer lists is refused.
    expect((await pick({ id: 'gpt-6.1-sol' })).status).toBe(400);
    expect((await pick({ id: 'gpt-7-nova', variant: 'ultra' })).status).toBe(204);
    expect(await store.getSession(id)).toMatchObject({ model: 'gpt-7-nova', effort: 'ultra' });
    // gpt-5.5 does not offer ultra, so picking it without a variant moves the chat to the default effort.
    expect((await pick({ id: 'gpt-5.5' })).status).toBe(204);
    expect(await store.getSession(id)).toMatchObject({ model: 'gpt-5.5', effort: 'medium' });
    // An effort it offers is kept when the next pick names none.
    expect((await pick({ id: 'gpt-5.5', variant: 'high' })).status).toBe(204);
    expect((await pick({ id: 'gpt-7-nova' })).status).toBe(204);
    expect(await store.getSession(id)).toMatchObject({ model: 'gpt-7-nova', effort: 'high' });

    // A prompt is checked against the same list before a process starts.
    const refused = await request(`/api/session/${id}/prompt`, { body: { text: 'x', model: 'gpt-5.5', effort: 'ultra' } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Unknown effort for Codex gpt-5.5: ultra');
    expect((await request(`/api/session/${id}/prompt`, { body: { text: 'x', model: 'gpt-6.1-sol' } })).status).toBe(400);
    expect(spawns).toHaveLength(0);
  });

  it('refuses signing in to an engine in enterprise mode but still signs out', async () => {
    let logouts = 0;
    codex.auth.status = async () => ({ loggedIn: false });
    codex.auth.logout = async () => {
      logouts += 1;
    };

    expect((await request('/api/engines/codex/auth/login', { body: {} })).status).toBe(200);
    enterprise = true;
    const refused = await request('/api/engines/codex/auth/login', { body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('enterprise_mode');
    expect((await request('/api/auth/login', { body: {} })).status).toBe(403);
    expect(loginPtys).toHaveLength(1);
    await request('/api/engines/codex/auth/login', { method: 'DELETE' });

    expect((await request('/api/engines/codex/auth/logout', { body: {} })).body.success).toBe(true);
    expect(logouts).toBe(1);
  });
});

describe('engine handoff', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let first;
  let second;
  let holdReply;

  const reply = (text, proc) => {
    if (holdReply) return;
    proc.emit('engine.state', { conversationId: `conv-${proc.options.model}` });
    proc.emit('text.delta', { text: `echo: ${text.slice(-5)}` });
    proc.emit('turn.completed', { outcome: 'succeeded' });
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-handoff-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    holdReply = false;
    first = createFakeEngine({ id: 'first', reply });
    second = createFakeEngine({ id: 'second', reply });
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([first, second]),
      store,
      controlBridge: new ControlBridge(),
      streamHub: new StreamHub(),
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('hands a chat with history to another engine with the conversation so far', async () => {
    const id = (await post('/api/session', { engine: 'first' })).body.data.id;
    await post(`/api/session/${id}/prompt`, { text: 'hello' });
    await settle();

    const switched = await post(`/api/session/${id}/model`, { model: { providerID: 'second-provider', id: 'slow' } });
    expect(switched.status).toBe(204);

    await post(`/api/session/${id}/prompt`, { text: 'again' });
    await settle();
    const [proc] = second.processes;
    expect(proc.options).toMatchObject({ resume: false, handoff: true, engineState: null, model: 'slow' });
    expect(proc.sent[0]).toContain('<previous_conversation>');
    expect(proc.sent[0]).toContain('User:\nhello');
    expect(proc.sent[0]).toContain('Assistant:\necho: hello');
    expect(proc.sent[0].endsWith('again')).toBe(true);
    expect(await store.getSession(id)).toMatchObject({ engine: 'second', engineState: { conversationId: 'conv-slow' } });
    expect((await store.getSession(id)).handoff).toBeUndefined();

    await post(`/api/session/${id}/prompt`, { text: 'third' });
    await settle();
    expect(proc.sent[1]).toBe('third');
    const stored = (await store.getMessages(id)).filter((message) => message.role === 'user').map((message) => message.content);
    expect(stored).toEqual(['hello', 'again', 'third']);
  });

  it('refuses to switch engines while a turn is running', async () => {
    const id = (await post('/api/session', { engine: 'first' })).body.data.id;
    holdReply = true;
    await post(`/api/session/${id}/prompt`, { text: 'hello' });
    await settle();

    const refused = await post(`/api/session/${id}/model`, { model: { providerID: 'second-provider', id: 'slow' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('Fake first is still answering. Switch to Fake second once it is done.');
    expect((await store.getSession(id)).engine).toBe('first');
  });
});

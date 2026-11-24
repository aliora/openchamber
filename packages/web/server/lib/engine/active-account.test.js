import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { EngineAccounts } from './accounts.js';
import { LocalSessionStore } from './store.js';
import { registerEngineRoutes } from './routes.js';
import { createEngineRegistry } from './registry.js';
import { createFakeEngine } from './test/fake-engine.js';
import { TRANSFER_BUNDLE_VERSION } from './session-transfer.js';

describe('session-bound engine accounts', () => {
  let root, accounts, store, engine, target, server, url, shutdown, generated;
  const request = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const finish = async (process, text = 'answer') => {
    process.emit('text.delta', { text });
    process.emit('turn.completed', { outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const profile = (label, engineId = 'claude') => accounts.create(engineId, label);
  const create = async (body = {}) => (await request('/api/sessions', { engine: 'claude', ...body })).body;
  const prompt = (id, text = 'next', extra = {}) => request(`/api/session/${id}/prompt`, { text, ...extra });
  const switchAccount = (id, accountId) => request(`/api/session/${id}/account`, { accountId });
  const configDir = (process) => process.options.env?.CLAUDE_CONFIG_DIR;
  const transferBundle = (accountLabel) => {
    const session = { title: 'Moved', engine: 'claude', model: 'fast' };
    if (accountLabel !== undefined) session.accountLabel = accountLabel;
    return { version: TRANSFER_BUNDLE_VERSION, source: { hostname: 'other', sessionId: 'remote-1', cwd: root }, session, messages: [] };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-session-account-'));
    accounts = new EngineAccounts({ root });
    store = new LocalSessionStore({ storagePath: path.join(root, 'sessions.json') });
    engine = createFakeEngine({ id: 'claude' });
    target = createFakeEngine({ id: 'codex' });
    for (const adapter of [engine, target]) adapter.readAccountModels = async () => adapter.modelCatalog();
    const app = express();
    app.use(express.json());
    generated = [];
    const generateText = async (options) => { generated.push(options); return 'generated'; };
    ({ shutdown } = registerEngineRoutes(app, { registry: createEngineRegistry([engine, target]), accounts, store, generateText }));
    server = app.listen(0);
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { await shutdown(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('starts a session on the account the body names, else the same-engine parent, else the host default', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const codexWork = profile('Codex work', 'codex');
    accounts.setDefault('claude', work.id);
    expect((await create()).accountId).toBe(work.id);
    const named = await create({ accountId: personal.id });
    expect([named.accountId, named.accountLabel]).toEqual([personal.id, 'Personal']);
    expect((await create({ parentID: named.id })).accountId).toBe(personal.id);
    const codexParent = (await request('/api/sessions', { engine: 'codex', accountId: codexWork.id })).body;
    expect((await create({ parentID: codexParent.id })).accountId).toBe(work.id);
    expect((await request('/api/sessions', { engine: 'claude', accountId: codexWork.id })).status).toBe(400);
    expect((await request('/api/sessions', { engine: 'claude', accountId: 42 })).status).toBe(400);
    expect((await request('/api/sessions', { engine: 'claude', accountLabel: 'Work' })).status).toBe(400);
  });

  it('keeps an open session on its account when the host default changes', async () => {
    const work = profile('Work'), personal = profile('Personal');
    accounts.setDefault('claude', work.id);
    const chat = await create();
    accounts.setDefault('claude', personal.id);
    expect((await prompt(chat.id)).status).toBe(200);
    expect(engine.processes[0].options.accountId).toBe(work.id);
    expect(configDir(engine.processes[0])).toBe(accounts.home('claude', work.id));
    expect((await store.getSession(chat.id)).accountId).toBe(work.id);
    expect((await create()).accountId).toBe(personal.id);
  });

  it('moves only the session whose account is switched, handing its history to the new account', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const first = await create({ accountId: work.id });
    const second = await create({ accountId: work.id });
    expect((await prompt(first.id, 'original')).status).toBe(200);
    first.process = engine.processes[0];
    first.process.emit('engine.state', { conversationId: 'work thread' });
    await finish(first.process, 'previous answer');

    const switched = await switchAccount(first.id, personal.id);
    expect(switched.status).toBe(200);
    expect([switched.body.data.accountId, switched.body.data.accountLabel]).toEqual([personal.id, 'Personal']);
    expect(first.process.isAlive).toBe(false);

    expect((await prompt(first.id)).status).toBe(200);
    expect((await prompt(second.id)).status).toBe(200);
    const [moved, untouched] = engine.processes.slice(1);
    expect(moved.options.accountId).toBe(personal.id);
    expect(configDir(moved)).toBe(accounts.home('claude', personal.id));
    expect(moved.options.engineState).toBeNull();
    expect(moved.options.resume).toBe(false);
    expect(moved.sent[0]).toContain('original');
    expect(moved.sent[0]).toContain('previous answer');
    expect(untouched.options.accountId).toBe(work.id);
    expect(configDir(untouched)).toBe(accounts.home('claude', work.id));
    first.process.emit('engine.state', { conversationId: 'late work thread' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.getSession(first.id)).engineState).toBeNull();
  });

  it('refuses an account switch while a turn runs, to a signed-out account or one without the session model', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const chat = await create({ accountId: work.id });
    await prompt(chat.id);
    expect((await switchAccount(chat.id, personal.id)).status).toBe(409);
    await finish(engine.processes[0]);

    const personalHome = accounts.home('claude', personal.id);
    engine.auth.status = async (context) => ({ loggedIn: context?.env?.CLAUDE_CONFIG_DIR !== personalHome });
    expect((await switchAccount(chat.id, personal.id)).status).toBe(409);
    engine.auth.status = async () => ({ loggedIn: true });

    engine.readAccountModels = async (context) => (context.env.CLAUDE_CONFIG_DIR === personalHome
      ? { models: [{ id: 'different', name: 'Different' }], defaultModel: 'different' }
      : engine.modelCatalog());
    await accounts.adapter(engine, personal.id).refreshModelCatalog();
    expect((await switchAccount(chat.id, personal.id)).status).toBe(400);

    expect((await switchAccount(chat.id, 'b8a0f5c4-2d7e-4a51-9e4a-3f1c2b6d7e80')).status).toBe(404);
    expect((await switchAccount(chat.id, undefined)).status).toBe(400);
    expect((await request(`/api/session/${chat.id}`, { accountId: personal.id }, 'PATCH')).status).toBe(400);
    expect((await store.getSession(chat.id)).accountId).toBe(work.id);
    expect((await switchAccount(chat.id, work.id)).status).toBe(200);
  });

  it('refuses the turn of a session whose account is signed out, without falling back to another account', async () => {
    const work = profile('Work');
    const chat = await create({ accountId: work.id });
    await store.updateSession(chat.id, { engineState: { conversationId: 'keep' } });
    engine.auth.status = async () => ({ loggedIn: false });
    const refused = await prompt(chat.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Work');
    expect(engine.processes).toHaveLength(0);
    expect(await store.getMessages(chat.id)).toHaveLength(0);
    expect(await store.getSession(chat.id)).toMatchObject({ accountId: work.id, engineState: { conversationId: 'keep' } });
  });

  it('keeps a session whose account was deleted readable, refuses its turns and lets the user pick another account', async () => {
    const work = profile('Work');
    const chat = await create({ accountId: work.id });
    await prompt(chat.id, 'original');
    await finish(engine.processes[0]);
    expect((await request(`/api/engines/claude/accounts/${work.id}`, undefined, 'DELETE')).status).toBe(204);
    expect(engine.processes[0].isAlive).toBe(false);
    expect((await request(`/api/session/${chat.id}`)).status).toBe(200);
    expect((await request(`/api/session/${chat.id}/message`)).status).toBe(200);
    const refused = await prompt(chat.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Work');
    expect((await request(`/api/session/${chat.id}/generate`, { prompt: 'summarize' })).status).toBe(409);
    expect(engine.processes).toHaveLength(1);

    expect((await switchAccount(chat.id, 'default')).status).toBe(200);
    expect((await prompt(chat.id)).status).toBe(200);
    expect(engine.processes[1].options.accountId).toBe('default');
    expect(engine.processes[1].options.resume).toBe(false);
    expect(engine.processes[1].sent[0]).toContain('original');
  });

  it('wakes a synthetic resume on the session account and keeps pending context after a refusal', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const chat = await create({ accountId: work.id });
    accounts.setDefault('claude', personal.id);
    engine.auth.status = async () => ({ loggedIn: false });
    expect((await request(`/api/session/${chat.id}/synthetic`, { text: 'wake', resume: true })).status).toBe(409);
    engine.auth.status = async () => ({ loggedIn: true });
    expect((await request(`/api/session/${chat.id}/synthetic`, { text: 'wake again', resume: true })).status).toBe(200);
    expect(engine.processes[0].options.accountId).toBe(work.id);
    expect(engine.processes[0].sent[0]).toContain('wake again');
    expect(engine.processes[0].sent[0]).not.toContain('wake\n');
  });

  it('takes the parent account on an engine change of a sub-session, and a fork keeps its source account', async () => {
    const work = profile('Work');
    const codexWork = profile('Codex work', 'codex');
    const codexParent = (await request('/api/sessions', { engine: 'codex', accountId: codexWork.id })).body;
    const child = await create({ parentID: codexParent.id });
    expect(child.accountId).toBe('default');
    expect((await request(`/api/session/${child.id}/model`, { model: { providerID: 'codex-provider', id: 'fast' } })).status).toBe(204);
    expect((await store.getSession(child.id)).accountId).toBe(codexWork.id);

    const chat = await create({ accountId: work.id });
    await store.appendMessage(chat.id, { id: 'old', role: 'assistant', content: 'history', createdAt: 1 });
    expect((await request(`/api/session/${chat.id}/model`, { model: { providerID: 'claude-provider', id: 'slow' } })).status).toBe(204);
    expect((await store.getSession(chat.id)).accountId).toBe(work.id);
    const fork = await request(`/api/session/${chat.id}/fork`, {});
    expect(fork.status).toBe(200);
    expect((await store.getSession(fork.body.data.id)).accountId).toBe(work.id);
  });

  it('checks a session generation against the session account models', async () => {
    const work = profile('Work');
    const chat = await create({ accountId: work.id });
    engine.readAccountModels = async () => ({ models: [{ id: 'different', name: 'Different' }], defaultModel: 'different' });
    await accounts.adapter(engine, work.id).refreshModelCatalog();
    expect((await request(`/api/session/${chat.id}/generate`, { prompt: 'summarize' })).status).toBe(400);
  });

  it('refuses a turn when the session account cannot list its models, even if the fallback lists the model', async () => {
    const work = profile('Work');
    const chat = await store.createSession({ engine: 'claude', model: 'sonnet', permissionMode: 'ask', accountId: work.id, accountLabel: 'Work' });
    engine.readAccountModels = async () => { throw new Error('discovery unavailable'); };
    expect((await prompt(chat.id)).status).toBe(503);
    expect(engine.processes).toHaveLength(0);
  });

  it('binds a moved session to the account of the same name on this host and refuses a name it lacks', async () => {
    const work = profile('Work');
    const importBundle = (accountLabel) => request('/api/sessions/import-transfer', { bundle: transferBundle(accountLabel), cwd: root });
    const sessionOf = (result) => store.getSession(result.body.data.sessionId);

    const named = await importBundle('work');
    expect(named.status).toBe(201);
    expect((await sessionOf(named)).accountId).toBe(work.id);
    accounts.setDefault('claude', work.id);
    expect((await sessionOf(await importBundle(null))).accountId).toBe('default');
    expect((await sessionOf(await importBundle(undefined))).accountId).toBe(work.id);
    const missing = await importBundle('Personal');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('Personal');
  });

  it('starts a server-sent prompt on the account the session has when the turn starts, never on a stale record', async () => {
    const work = profile('Work'), personal = profile('Personal');
    let entered, release;
    const blocked = new Promise((resolve) => { entered = resolve; });
    let authCalls = 0;
    engine.auth.status = async () => {
      authCalls += 1;
      if (authCalls === 1) {
        entered();
        await new Promise((resolve) => { release = resolve; });
      }
      return { loggedIn: true };
    };
    const importing = request('/api/sessions/import-transfer', { bundle: transferBundle('Work'), cwd: root, prompt: 'continue' });
    await blocked;
    const [moved] = await store.listSessions();
    // Another writer touched the store, so the next read reloads it from disk.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'sessions.json'), later, later);
    const switching = switchAccount(moved.id, personal.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [imported] = await Promise.all([importing, switching]);
    expect(imported.status).toBe(201);
    expect(engine.processes).toHaveLength(1);
    const record = await store.getSession(moved.id);
    expect(engine.processes[0].options.accountId).toBe(record.accountId);
    expect(configDir(engine.processes[0])).toBe(accounts.home('claude', record.accountId));
    expect([work.id, personal.id]).toContain(record.accountId);
  });

  it('runs a one-off generation for a session on that session account, and one without a session on the host default', async () => {
    const work = profile('Work'), personal = profile('Personal');
    accounts.setDefault('claude', personal.id);
    const chat = await create({ accountId: work.id });
    const generate = (headers) => fetch(`${url}/api/experimental/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ prompt: 'name this chat', model: { providerID: 'claude-provider', id: 'fast' } }),
    });
    expect((await generate({ 'x-openchamber-session-id': chat.id })).status).toBe(200);
    expect((await generate({})).status).toBe(200);
    expect(generated.map((call) => [call.accountId, call.env?.CLAUDE_CONFIG_DIR])).toEqual([
      [work.id, accounts.home('claude', work.id)],
      [personal.id, accounts.home('claude', personal.id)],
    ]);
    expect((await request(`/api/engines/claude/accounts/${work.id}`, undefined, 'DELETE')).status).toBe(204);
    expect((await generate({ 'x-openchamber-session-id': chat.id })).status).toBe(404);
    expect(generated).toHaveLength(2);
  });

  it('refuses a generation naming a session or account it cannot match, instead of running it on the host default', async () => {
    const work = profile('Work'), personal = profile('Personal');
    accounts.setDefault('claude', personal.id);
    const chat = await create({ accountId: work.id });
    const generate = (headers) => fetch(`${url}/api/experimental/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ prompt: 'summarize the diff', model: { providerID: 'claude-provider', id: 'fast' } }),
    });
    expect((await generate({ 'x-openchamber-session-id': 'ses_missing' })).status).toBe(404);
    expect((await generate({ 'x-openchamber-session-id': 'bad id!' })).status).toBe(400);
    expect((await fetch(`${url}/api/model`, { headers: { 'x-openchamber-session-id': 'ses_missing' } })).status).toBe(404);
    await request(`/api/session/${chat.id}`, undefined, 'DELETE');
    expect((await generate({ 'x-openchamber-session-id': chat.id })).status).toBe(404);
    expect((await generate({ 'x-openchamber-account': 'claude' })).status).toBe(400);
    expect((await generate({ 'x-openchamber-account': 'nope:acc' })).status).toBe(400);
    expect((await generate({ 'x-openchamber-account': 'claude:b8a0f5c4-2d7e-4a51-9e4a-3f1c2b6d7e80' })).status).toBe(404);
    expect(generated).toHaveLength(0);
    expect((await generate({ 'x-openchamber-account': `claude:${work.id}` })).status).toBe(200);
    expect(generated.map((call) => call.env?.CLAUDE_CONFIG_DIR)).toEqual([accounts.home('claude', work.id)]);
  });

  it('lists and runs only the engines a named-account session has an account on; an ambient session keeps every engine', async () => {
    const work = profile('Work');
    const codexWork = profile('Codex work', 'codex');
    const chat = await create({ accountId: work.id });
    const ambient = await create({ accountId: 'default' });
    const providersOf = async (sessionId) => [...new Set((await (await fetch(`${url}/api/model`, { headers: { 'x-openchamber-session-id': sessionId } })).json()).data.map((model) => model.providerID))].sort();
    const generateOn = (sessionId, providerID) => fetch(`${url}/api/experimental/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openchamber-session-id': sessionId },
      body: JSON.stringify({ prompt: 'name this chat', model: { providerID, id: 'fast' } }),
    });
    expect(await providersOf(chat.id)).toEqual(['claude-provider']);
    expect((await generateOn(chat.id, 'codex-provider')).status).toBe(409);
    expect(generated).toHaveLength(0);
    expect(await providersOf(ambient.id)).toEqual(['claude-provider', 'codex-provider']);
    expect((await generateOn(ambient.id, 'codex-provider')).status).toBe(200);
    await store.updateSession(chat.id, { engineAccounts: { codex: codexWork.id } });
    expect(await providersOf(chat.id)).toEqual(['claude-provider', 'codex-provider']);
    expect((await generateOn(chat.id, 'codex-provider')).status).toBe(200);
    expect(generated.map((call) => call.env?.CODEX_HOME)).toEqual([undefined, accounts.home('codex', codexWork.id)]);
  });

  it('holds a draft that picked a named account to that account the way it holds a session', async () => {
    const work = profile('Work');
    const generateOn = (account, providerID) => fetch(`${url}/api/experimental/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openchamber-account': account },
      body: JSON.stringify({ prompt: 'write a commit message', model: { providerID, id: 'fast' } }),
    });
    const providersOf = async (account) => [...new Set((await (await fetch(`${url}/api/model`, { headers: { 'x-openchamber-account': account } })).json()).data.map((model) => model.providerID))].sort();
    expect(await providersOf(`claude:${work.id}`)).toEqual(['claude-provider']);
    expect((await generateOn(`claude:${work.id}`, 'codex-provider')).status).toBe(409);
    expect(generated).toHaveLength(0);
    expect((await generateOn(`claude:${work.id}`, 'claude-provider')).status).toBe(200);
    expect(await providersOf('claude:default')).toEqual(['claude-provider', 'codex-provider']);
    expect((await generateOn('claude:default', 'codex-provider')).status).toBe(200);
    expect(generated.map((call) => [call.adapter.id, call.env?.CLAUDE_CONFIG_DIR])).toEqual([
      ['claude', accounts.home('claude', work.id)],
      ['codex', undefined],
    ]);
  });

  it('returns to the account a session last used on an engine after a round trip through another engine', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const codexWork = profile('Codex work', 'codex');
    accounts.setDefault('claude', personal.id);
    const chat = await create({ accountId: work.id });
    expect((await request(`/api/session/${chat.id}/model`, { model: { providerID: 'codex-provider', id: 'fast' } })).status).toBe(204);
    expect((await store.getSession(chat.id)).accountId).toBe('default');
    expect((await switchAccount(chat.id, codexWork.id)).status).toBe(200);
    expect((await request(`/api/session/${chat.id}/model`, { model: { providerID: 'claude-provider', id: 'fast' } })).status).toBe(204);
    expect((await store.getSession(chat.id)).accountId).toBe(work.id);
    expect((await request(`/api/session/${chat.id}/model`, { model: { providerID: 'codex-provider', id: 'fast' } })).status).toBe(204);
    expect((await store.getSession(chat.id)).accountId).toBe(codexWork.id);
  });

  it('tells every client when a session moves to another account', async () => {
    const work = profile('Work'), personal = profile('Personal');
    const chat = await create({ accountId: work.id });
    const controller = new AbortController();
    const stream = await fetch(`${url}/api/global/event`, { signal: controller.signal });
    const reader = stream.body.getReader();
    expect((await switchAccount(chat.id, personal.id)).status).toBe(200);
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('model.updated')) text += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('"engine":"claude"');
  });

  it('lists the models of the account a composer names, and the host default without one', async () => {
    const work = profile('Work');
    const workHome = accounts.home('claude', work.id);
    engine.readAccountModels = async (context) => (context.env.CLAUDE_CONFIG_DIR === workHome
      ? { models: [{ id: 'work-only', name: 'Work' }], defaultModel: 'work-only' }
      : engine.modelCatalog());
    const claudeModels = (catalog) => catalog.body.data.filter((model) => model.providerID === 'claude-provider').map((model) => model.id);
    expect(claudeModels(await request(`/api/model?engine=claude&accountId=${work.id}`))).toEqual(['work-only']);
    expect(claudeModels(await request('/api/model'))).toEqual(['fast', 'slow']);
    expect((await request(`/api/model?engine=codex&accountId=${work.id}`)).status).toBe(404);
  });

  it('refreshes a newly selected profile before returning its model list', async () => {
    accounts.setDefault('claude', profile('Work').id);
    engine.readAccountModels = async () => ({ models: [{ id: 'work-only', name: 'Work' }], defaultModel: 'work-only' });
    const result = await request('/api/engines/claude/models/refresh', {});
    expect(result.status).toBe(200);
    expect(result.body.models.map((model) => model.id)).toEqual(['work-only']);
  });

  it('keeps an accepted prompt successful when title account resolution fails', async () => {
    const chat = await create();
    const resolveAdapter = accounts.adapter;
    const createProcess = engine.createProcess;
    engine.createProcess = (options) => {
      const process = createProcess(options);
      const send = process.sendUserMessage;
      process.sendUserMessage = (...args) => {
        send(...args);
        accounts.adapter = () => { throw new Error('registry temporarily unreadable'); };
      };
      return process;
    };
    try {
      expect((await prompt(chat.id)).status).toBe(200);
      expect(engine.processes[0].isAlive).toBe(true);
      expect(engine.processes[0].sent).toEqual(['next']);
      expect((await store.getMessages(chat.id)).filter((message) => message.role === 'user')).toHaveLength(1);
    } finally { accounts.adapter = resolveAdapter; }
  });
});

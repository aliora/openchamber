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

describe('active engine account admission', () => {
  let root, accounts, store, engine, target, server, url, shutdown;
  const request = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const finish = async (process, text = 'answer') => {
    process.emit('text.delta', { text });
    process.emit('turn.completed', { outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const profile = (label) => accounts.create('claude', label);
  const create = async () => (await request('/api/sessions', { engine: 'claude' })).body;
  const prompt = (id, text = 'next', extra = {}) => request(`/api/session/${id}/prompt`, { text, ...extra });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-active-account-'));
    accounts = new EngineAccounts({ root });
    store = new LocalSessionStore({ storagePath: path.join(root, 'sessions.json') });
    engine = createFakeEngine({ id: 'claude' });
    target = createFakeEngine({ id: 'codex' });
    for (const adapter of [engine, target]) adapter.readAccountModels = async () => adapter.modelCatalog();
    const app = express();
    app.use(express.json());
    ({ shutdown } = registerEngineRoutes(app, { registry: createEngineRegistry([engine, target]), accounts, store, generateText: async () => 'generated' }));
    server = app.listen(0);
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { await shutdown(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('starts a fresh conversation on the next active account with stored history', async () => {
    const a = profile('One'), b = profile('Two');
    accounts.setDefault('claude', a.id);
    const chat = await create();
    expect((await prompt(chat.id, 'original')).status).toBe(200);
    engine.processes[0].emit('engine.state', { conversationId: 'foreign' });
    await finish(engine.processes[0], 'previous answer');
    accounts.setDefault('claude', b.id);
    expect((await prompt(chat.id)).status).toBe(200);
    const fresh = engine.processes[1];
    expect(fresh.options.accountId).toBe(b.id);
    expect(fresh.options.engineState).toBeNull();
    expect(fresh.options.resume).toBe(false);
    expect(fresh.sent[0]).toContain('original');
    expect(fresh.sent[0]).toContain('previous answer');
    expect((await store.getSession(chat.id)).accountId).toBe(b.id);
    engine.processes[0].emit('engine.state', { conversationId: 'late foreign' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.getSession(chat.id)).engineState).toBeNull();
  });

  it('keeps a running turn on its account and refuses a new-account send until it drains', async () => {
    const a = profile('One'), b = profile('Two');
    accounts.setDefault('claude', a.id);
    const chat = await create();
    await prompt(chat.id);
    accounts.setDefault('claude', b.id);
    expect((await prompt(chat.id, 'new account')).status).toBe(409);
    expect(engine.processes).toHaveLength(1);
    expect(engine.processes[0].isAlive).toBe(true);
    expect((await store.getMessages(chat.id)).filter((m) => m.role === 'user')).toHaveLength(1);
    expect((await request(`/api/engines/claude/accounts/${a.id}`, undefined, 'DELETE')).status).toBe(409);
    await finish(engine.processes[0]);
    expect((await prompt(chat.id)).status).toBe(200);
    expect(engine.processes[1].options.accountId).toBe(b.id);
  });

  it('serializes two concurrent sends across one account transition', async () => {
    const chat = await create();
    await store.appendMessage(chat.id, { id: 'old', role: 'assistant', content: 'history', createdAt: 1 });
    const account = profile('Work');
    accounts.setDefault('claude', account.id);
    const replies = await Promise.all([prompt(chat.id, 'one'), prompt(chat.id, 'two')]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    expect(engine.processes).toHaveLength(1);
    expect(engine.processes[0].sent).toHaveLength(2);
    expect(engine.processes[0].sent.filter((text) => text.includes('history'))).toHaveLength(1);
  });

  it('fails closed before storing a turn or changing identity when active auth or model is missing', async () => {
    const chat = await create();
    await store.updateSession(chat.id, { engineState: { conversationId: 'keep' } });
    const account = profile('Work');
    accounts.setDefault('claude', account.id);
    engine.auth.status = async () => ({ loggedIn: false });
    expect((await prompt(chat.id)).status).toBe(409);
    engine.auth.status = async () => ({ loggedIn: true });
    engine.readAccountModels = async () => ({ models: [{ id: 'different', name: 'Different' }], defaultModel: 'different' });
    await accounts.adapter(engine, account.id).refreshModelCatalog();
    expect((await prompt(chat.id)).status).toBe(400);
    expect((await store.getSession(chat.id)).accountId).toBe('default');
    expect((await store.getSession(chat.id)).engineState).toEqual({ conversationId: 'keep' });
    expect(await store.getMessages(chat.id)).toHaveLength(0);
    expect(engine.processes).toHaveLength(0);
  });

  it('uses the target active account on an engine change and fork', async () => {
    const a = profile('One');
    const b = accounts.create('codex', 'Two');
    accounts.setDefault('claude', a.id);
    accounts.setDefault('codex', b.id);
    const chat = await create();
    await store.appendMessage(chat.id, { id: 'old', role: 'assistant', content: 'history', createdAt: 1 });
    expect((await request(`/api/session/${chat.id}/model`, { model: { providerID: 'codex-provider', id: 'fast' } })).status).toBe(204);
    expect((await store.getSession(chat.id)).accountId).toBe(b.id);
    accounts.setDefault('codex', 'default');
    const fork = await request(`/api/session/${chat.id}/fork`, {});
    expect(fork.status).toBe(200);
    expect((await store.getSession(fork.body.data.id)).accountId).toBe('default');
  });

  it('rejects legacy explicit account overrides and always catalogs the active account', async () => {
    const a = profile('One');
    expect((await request('/api/sessions', { engine: 'claude', accountId: 'default' })).status).toBe(400);
    accounts.setDefault('claude', a.id);
    engine.readAccountModels = async () => ({ models: [{ id: 'work-only', name: 'Work' }], defaultModel: 'work-only' });
    const catalog = await request('/api/model?engine=claude&accountId=default');
    expect(JSON.stringify(catalog.body)).toContain('work-only');
    expect(catalog.body.data.filter((model) => model.providerID === 'claude-provider').map((model) => model.id)).toEqual(['work-only']);
  });

  it('removes an idle account without deleting chats and migrates its legacy records next turn', async () => {
    const a = profile('One');
    accounts.setDefault('claude', a.id);
    const chat = await create();
    await prompt(chat.id, 'original');
    await finish(engine.processes[0]);
    expect((await request(`/api/engines/claude/accounts/${a.id}`, undefined, 'DELETE')).status).toBe(204);
    expect(engine.processes[0].isAlive).toBe(false);
    expect((await request(`/api/session/${chat.id}`)).status).toBe(200);
    expect((await prompt(chat.id)).status).toBe(200);
    expect(engine.processes[1].options.accountId).toBe('default');
    expect(engine.processes[1].options.resume).toBe(false);
  });

  it('protects an account while admission is checking auth and detects a newer selection', async () => {
    const a = profile('One'), b = profile('Two');
    accounts.setDefault('claude', a.id);
    const chat = await create();
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    engine.auth.status = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return { loggedIn: true }; };
    // Creation has already cached the profile adapter; its auth implementation delegates through the profile context.
    accounts.adapters.clear();
    const pending = prompt(chat.id);
    await started;
    expect((await request(`/api/engines/claude/accounts/${a.id}`, undefined, 'DELETE')).status).toBe(409);
    accounts.setDefault('claude', b.id);
    release();
    expect((await pending).status).toBe(409);
    expect(engine.processes).toHaveLength(0);
    expect(await store.getMessages(chat.id)).toHaveLength(0);
  });

  it('hands synthetic resume to the active account and preserves pending context after auth refusal', async () => {
    const chat = await create();
    const a = profile('Work');
    accounts.setDefault('claude', a.id);
    engine.auth.status = async () => ({ loggedIn: false });
    expect((await request(`/api/session/${chat.id}/synthetic`, { text: 'wake', resume: true })).status).toBe(409);
    engine.auth.status = async () => ({ loggedIn: true });
    accounts.adapters.clear();
    expect((await request(`/api/session/${chat.id}/synthetic`, { text: 'wake again', resume: true })).status).toBe(200);
    expect(engine.processes[0].options.accountId).toBe(a.id);
    expect(engine.processes[0].sent[0]).toContain('wake again');
    expect(engine.processes[0].sent[0]).not.toContain('wake\n');
  });

  it('rejects a session generation when its model is absent from the active profile', async () => {
    const chat = await create();
    const a = profile('Work');
    accounts.setDefault('claude', a.id);
    engine.readAccountModels = async () => ({ models: [{ id: 'different', name: 'Different' }], defaultModel: 'different' });
    expect((await request(`/api/session/${chat.id}/generate`, { prompt: 'summarize' })).status).toBe(400);
  });

  it('refuses handoff when profile discovery fails even if its fallback lists the model', async () => {
    const chat = await store.createSession({ engine: 'claude', model: 'sonnet', permissionMode: 'ask' });
    accounts.setDefault('claude', profile('Work').id);
    engine.readAccountModels = async () => { throw new Error('discovery unavailable'); };
    expect((await prompt(chat.id)).status).toBe(503);
    expect(engine.processes).toHaveLength(0);
    expect((await store.getSession(chat.id)).accountId).toBe('default');
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

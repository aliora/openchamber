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
import { EngineSessionRuntime } from './session-runtime.js';
import { StreamHub } from './stream-hub.js';
import { ControlBridge } from './control-bridge.js';
import { runCli } from './cli-platform.js';
import { createLoginSessions } from './login-session.js';

describe('engine accounts', () => {
  let root;
  let accounts;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-account-'));
    accounts = new EngineAccounts({ root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('persists engine defaults while explicit ambient sessions stay ambient', () => {
    const first = accounts.create('claude', 'Work');
    const second = accounts.create('codex', 'Work');
    accounts.setDefault('claude', first.id);
    const reload = new EngineAccounts({ root });
    expect(reload.resolve('claude').id).toBe(first.id);
    expect(reload.resolve('claude', 'default').id).toBe('default');
    expect(reload.resolve('codex').id).toBe('default');
    expect(() => reload.resolve('codex', first.id)).toThrow('Unknown account');
    expect(first.id).not.toBe(second.id);
    expect(accounts.list('antigravity')).toEqual({ supported: false, data: [{ id: 'default', label: 'Default', isDefault: true }] });
    expect(() => accounts.create('antigravity', 'Other')).toThrow('not supported');
  });

  it('rejects invalid names, duplicate names and path-shaped ids', () => {
    expect(() => accounts.create('claude', ' ')).toThrow();
    accounts.create('claude', 'Work');
    expect(() => accounts.create('claude', ' work ')).toThrow('already exists');
    expect(() => accounts.resolve('claude', '../default')).toThrow('Unknown account');
    expect(() => accounts.remove('claude', 'default')).toThrow('cannot be deleted');
  });

  it('fails closed on malformed registries and missing named homes', () => {
    const profile = accounts.create('claude', 'Work');
    fs.rmSync(accounts.home('claude', profile.id), { recursive: true });
    expect(() => accounts.environment('claude', profile.id)).toThrow('missing or invalid');
    fs.writeFileSync(accounts.file, '{}');
    expect(() => accounts.resolve('claude')).toThrow('cannot be read');
    expect(accounts.environment('claude', 'default', { TEST: 'ok' })).toEqual({ TEST: 'ok' });
  });

  it('scrubs inherited auth overrides without mutating the host environment', async () => {
    const profile = accounts.create('codex', 'Work');
    const inherited = { ...process.env, OPENAI_API_KEY: 'test-key', ANTHROPIC_AUTH_TOKEN: 'test-token', CLAUDE_CODE_OAUTH_TOKEN: 'test-token', CODEX_HOME: 'other', CODEX_SQLITE_HOME: 'other', OPENCHAMBER_MCP_TOKEN: 'host-tool-token' };
    const env = accounts.environment('codex', profile.id, inherited);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CODEX_SQLITE_HOME).toBeUndefined();
    expect(env.OPENCHAMBER_MCP_TOKEN).toBe('host-tool-token');
    expect(inherited.CODEX_HOME).toBe('other');
    expect(env.CODEX_HOME).toBe(accounts.home('codex', profile.id));
    expect(fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
    // A subprocess receives the complete sanitized environment, without an inherited merge.
    const result = await runCli({ command: process.execPath, isWindows: false }, ['-e', 'process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME}))'], { env });
    expect(JSON.parse(result.stdout)).toEqual({ home: env.CODEX_HOME });
  });

  it('rolls back a failed metadata write and keeps the original named home', () => {
    const profile = accounts.create('claude', 'Work');
    accounts.save = () => { throw new Error('disk full'); };
    expect(() => accounts.remove('claude', profile.id)).toThrow('disk full');
    expect(new EngineAccounts({ root }).resolve('claude', profile.id).id).toBe(profile.id);
  });

  it('deletes an unused default profile and returns new sessions to ambient', () => {
    const profile = accounts.create('claude', 'Work');
    accounts.setDefault('claude', profile.id);
    accounts.remove('claude', profile.id);
    expect(accounts.resolve('claude').id).toBe('default');
    expect(fs.existsSync(accounts.home('claude', profile.id))).toBe(false);
    expect(() => accounts.resolve('claude', profile.id)).toThrow('Unknown account');
  });

  it('runs simultaneous login PTYs with distinct profile homes and independent cancellation', async () => {
    const engine = createFakeEngine({ id: 'claude' });
    engine.auth.status = async () => ({ loggedIn: false });
    engine.auth.loginProcess = () => ({ command: 'claude', args: ['auth', 'login'] });
    const a = accounts.adapter(engine, accounts.create('claude', 'One').id);
    const b = accounts.adapter(engine, accounts.create('claude', 'Two').id);
    const launches = [];
    const login = createLoginSessions({ onSettled: () => {}, spawnPty: async (_command, _args, options) => {
      const child = { pid: 0, killed: false, onData: () => {}, onExit: () => {}, kill() { this.killed = true; } };
      launches.push({ home: options.env.CLAUDE_CONFIG_DIR, child });
      return child;
    } });
    try {
      await Promise.all([login.start(a), login.start(b)]);
      expect(launches).toHaveLength(2);
      expect(launches[0].home).not.toBe(launches[1].home);
      await login.cancel(a);
      expect(login.get(a).state).toBe('cancelled');
      expect(login.get(b).state).toBe('starting');
      expect(launches[1].child.killed).toBe(false);
    } finally { await login.cancel(a); await login.cancel(b); }
  });

  it('isolates auth, login and model discovery between account adapters', async () => {
    const base = createFakeEngine({ id: 'codex' });
    const seen = [];
    base.auth.status = async ({ env }) => ({ loggedIn: false, email: env.CODEX_HOME });
    base.auth.loginProcess = () => ({ command: 'codex', args: ['login', '--device-auth'] });
    base.readAccountModels = async ({ env }) => { seen.push(env.CODEX_HOME); return base.modelCatalog(); };
    const first = accounts.create('codex', 'One');
    const second = accounts.create('codex', 'Two');
    const a = accounts.adapter(base, first.id);
    const b = accounts.adapter(base, second.id);
    await Promise.all([a.ensureModelCatalog(), b.ensureModelCatalog()]);
    expect(new Set(seen).size).toBe(2);
    expect((await a.auth.status()).email).toBe(accounts.home('codex', first.id));
    expect(a.auth.loginProcess().args.slice(0, 2)).toEqual(['-c', 'cli_auth_credentials_store="file"']);
    expect(a.auth.loginProcess().env.CODEX_HOME).not.toBe(b.auth.loginProcess().env.CODEX_HOME);
    expect(a.loginKey).not.toBe(b.loginKey);
  });
});

describe('account routes and session binding', () => {
  let root, accounts, store, server, url, engine, runtime, shutdown;
  const request = async (route, method = 'GET', body) => {
    const res = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-account-routes-'));
    accounts = new EngineAccounts({ root });
    store = new LocalSessionStore({ storagePath: path.join(root, 'sessions.json') });
    engine = createFakeEngine({ id: 'claude' });
    engine.readAccountModels = async () => engine.modelCatalog();
    engine.auth.status = async () => ({ loggedIn: false });
    engine.auth.loginProcess = () => ({ command: 'fake', args: ['login'] });
    const app = express();
    app.use(express.json());
    ({ shutdown } = registerEngineRoutes(app, { registry: createEngineRegistry([engine, createFakeEngine({ id: 'other' })]), accounts, store, isEnterpriseMode: () => true }));
    runtime = new EngineSessionRuntime({ store, accounts, streamHub: new StreamHub(), controlBridge: new ControlBridge() });
    server = app.listen(0);
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { await runtime.shutdown(); await shutdown(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('records the creation identity and rejects direct account patches while engine changes follow active accounts', async () => {
    const created = await request('/api/engines/claude/accounts', 'POST', { label: 'Work' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await request(`/api/engines/claude/accounts/${id}/default`, 'POST')).status).toBe(200);
    const session = (await request('/api/sessions', 'POST', { engine: 'claude' })).body;
    expect(session.accountId).toBe(id);
    expect(session.accountLabel).toBe('Work');
    await request('/api/engines/claude/accounts/default/default', 'POST');
    const ambient = (await request('/api/sessions', 'POST', { engine: 'claude' })).body;
    expect(ambient.accountId).toBe('default');
    expect((await new LocalSessionStore({ storagePath: store.storagePath }).getSession(session.id)).accountId).toBe(id);
    expect((await request(`/api/session/${session.id}`, 'PATCH', { accountId: 'default' })).status).toBe(400);
    expect((await request(`/api/session/${session.id}/model`, 'POST', { model: { providerID: 'other-provider', id: 'fast' } })).status).toBe(204);
    expect((await request(`/api/engines/claude/accounts/${id}`, 'DELETE')).status).toBe(204);
    expect((await store.getSession(session.id)).accountId).toBe('default');
  });

  it('refuses unknown, cross-engine and unsupported accounts before creating a session', async () => {
    const codex = accounts.create('codex', 'Elsewhere');
    expect((await request('/api/sessions', 'POST', { engine: 'claude', accountId: codex.id })).status).toBe(400);
    expect((await request('/api/sessions', 'POST', { engine: 'claude', accountId: '../../ambient' })).status).toBe(400);
    expect(await store.listSessions()).toHaveLength(0);
    expect((await request('/api/engines/other/accounts', 'POST', { label: 'No' })).status).toBe(501);
  });

  it('refuses ambient deletion before invoking sign-out', async () => {
    let signedOut = false;
    engine.auth.logout = () => { signedOut = true; };
    expect((await request('/api/engines/claude/accounts/default', 'DELETE')).status).toBe(409);
    expect(signedOut).toBe(false);
  });

  it('legacy authentication status follows the selected engine default', async () => {
    engine.auth.status = async (context) => ({ loggedIn: false, reason: context?.env?.CLAUDE_CONFIG_DIR ? 'named' : 'ambient' });
    const profile = accounts.create('claude', 'Work');
    accounts.setDefault('claude', profile.id);
    expect((await request('/api/engines/claude/auth/status')).body.reason).toBe('named');
    expect((await request('/api/auth/status')).body.reason).toBe('named');
    expect((await request('/api/engines/claude/accounts/default/auth/status')).body.reason).toBe('ambient');
  });

  it('blocks new bindings during removal and restores the profile when scoped sign-out fails', async () => {
    const profile = accounts.create('claude', 'Work');
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    engine.auth.logout = async ({ env, isolated }) => {
      expect(isolated).toBe(true);
      expect(env.CLAUDE_CONFIG_DIR).toBe(accounts.home('claude', profile.id));
      entered();
      await new Promise((resolve) => { release = resolve; });
      throw new Error('credential store unavailable');
    };
    const removal = request(`/api/engines/claude/accounts/${profile.id}`, 'DELETE');
    await started;
    expect((await request('/api/sessions', 'POST', { engine: 'claude', accountId: profile.id })).status).toBe(400);
    expect((await request(`/api/engines/claude/accounts/${profile.id}/auth/status`)).status).toBe(409);
    release();
    expect((await removal).status).toBe(500);
    expect(accounts.resolve('claude', profile.id).id).toBe(profile.id);
    expect(fs.existsSync(accounts.home('claude', profile.id))).toBe(true);
  });

  it('resumes removal after a server crash left the profile blocked', async () => {
    const profile = accounts.create('claude', 'Work');
    accounts.setDefault('claude', profile.id);
    accounts.setRemoving('claude', profile.id, true);
    expect(accounts.list('claude').data.some((entry) => entry.id === profile.id)).toBe(true);
    fs.renameSync(accounts.home('claude', profile.id), `${accounts.home('claude', profile.id)}.retired`);
    expect(accounts.list('claude').data.some((entry) => entry.id === profile.id)).toBe(true);
    expect((await request(`/api/engines/claude/accounts/${profile.id}`, 'DELETE')).status).toBe(204);
    expect(accounts.resolve('claude').id).toBe('default');
    expect(() => accounts.resolve('claude', profile.id)).toThrow('Unknown account');
  });

  it('enforces enterprise sign-in refusal on named account login', async () => {
    const { id } = accounts.create('claude', 'Work');
    const response = await request(`/api/engines/claude/accounts/${id}/auth/login`, 'POST');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('enterprise_mode');
    expect((await request(`/api/engines/claude/accounts/${id}/auth/status`)).body.loggedIn).toBe(false);
  });

  it('starts and resumes exactly the stored profile and refuses missing homes before reusing a live process', async () => {
    const { id } = accounts.create('claude', 'Work');
    const session = await store.createSession({ engine: 'claude', accountId: id, accountLabel: 'Work', engineState: { transcript: true } });
    const adapter = accounts.adapter(engine, id);
    const options = { session, adapter, model: 'fast', permissionMode: 'ask' };
    await runtime.ensureProcess(options);
    expect(engine.processes[0].options.env.CLAUDE_CONFIG_DIR).toBe(accounts.home('claude', id));
    expect(engine.processes[0].options.accountId).toBe(id);
    await runtime.abort(session.id);
    await runtime.ensureProcess(options);
    expect(engine.processes[1].options.env.CLAUDE_CONFIG_DIR).toBe(accounts.home('claude', id));
    fs.renameSync(accounts.home('claude', id), `${accounts.home('claude', id)}.missing`);
    await expect(runtime.ensureProcess(options)).rejects.toThrow('missing or invalid');
  });
});

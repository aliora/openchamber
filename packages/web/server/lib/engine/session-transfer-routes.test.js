import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerEngineRoutes } from './routes.js';
import { createEngineRegistry } from './registry.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { createFakeEngine } from './test/fake-engine.js';

const reply = (text, proc) => {
  proc.emit('text.delta', { text: `echo: ${text}` });
  proc.emit('turn.completed', { outcome: 'succeeded', usage: { input: 1, output: 1 } });
};

const createHost = (tmpDir, name, options = {}) => {
  const store = new LocalSessionStore({ storagePath: path.join(tmpDir, name, 'sessions.json') });
  const streamHub = new StreamHub();
  const events = [];
  const broadcast = streamHub.broadcast.bind(streamHub);
  streamHub.broadcast = (sessionId, event) => {
    events.push(event);
    broadcast(sessionId, event);
  };
  const fake = createFakeEngine({ id: 'fake', reply });
  const host = { store, fake, events, enterprise: false };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const engineRoutes = registerEngineRoutes(app, {
    registry: createEngineRegistry([fake]),
    store,
    controlBridge: new ControlBridge(),
    streamHub,
    isEnterpriseMode: () => host.enterprise,
    readSettings: async () => ({ projects: options.projects ?? [] }),
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  host.close = async () => {
    await engineRoutes.shutdown();
    server.close();
  };
  host.request = async (url, { body, method = body ? 'POST' : 'GET' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return host;
};

describe('session transfer routes', () => {
  let tmpDir;
  let source;
  let target;
  let sourceSession;
  let workDir;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const until = async (check) => {
    for (let attempt = 0; attempt < 100 && !(await check()); attempt += 1) await settle();
  };
  const exportBundle = async (query = '') => (await source.request(`/api/sessions/${sourceSession.id}/transfer-bundle${query}`)).body;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-transfer-routes-test-'));
    workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir);
    source = createHost(tmpDir, 'source');
    target = createHost(tmpDir, 'target');
    sourceSession = await source.store.createSession({ engine: 'fake', cwd: workDir, model: 'slow', title: 'Moving chat' });
    await source.store.updateSession(sourceSession.id, { metadata: { openchamber: { work: { label: 'w' }, transferredTo: { hostLabel: 'old' } } } });
    await source.store.appendMessages(sourceSession.id, [
      { id: 'msg-1', role: 'user', content: 'hello', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'msg-2', role: 'assistant', content: 'hi', parts: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  afterEach(async () => {
    await source.close();
    await target.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET transfer-bundle', () => {
    it('returns the bundle with every message', async () => {
      const res = await source.request(`/api/sessions/${sourceSession.id}/transfer-bundle`);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.source).toMatchObject({ sessionId: sourceSession.id, cwd: workDir });
      expect(res.body.session).toMatchObject({ title: 'Moving chat', engine: 'fake', model: 'slow' });
      expect(res.body.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
      expect(res.body.handoffSummary).toContain('<previous_conversation>');
      expect(res.body.git).toBeNull();
    });

    it('returns 404 for an unknown session', async () => {
      expect((await source.request('/api/sessions/missing/transfer-bundle')).status).toBe(404);
    });

    it('refuses in enterprise mode', async () => {
      source.enterprise = true;
      const res = await source.request(`/api/sessions/${sourceSession.id}/transfer-bundle`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('enterprise_mode');
    });

    it('returns null git for a cwd outside a repository even when asked', async () => {
      const res = await source.request(`/api/sessions/${sourceSession.id}/transfer-bundle?includeGitChanges=1`);
      expect(res.status).toBe(200);
      expect(res.body.git).toBeNull();
    });
  });

  describe('POST import-transfer', () => {
    it('creates a session with the same messages, handoff and transferredFrom', async () => {
      const bundle = await exportBundle();
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle, sourceHostLabel: 'Mac' } });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ matchedBy: 'same-path', gitTransferResult: null, prompted: false, promptError: null });

      const imported = await target.store.getSession(res.body.data.sessionId);
      expect(imported.title).toBe('Moving chat');
      expect(imported.engine).toBe('fake');
      expect(imported.model).toBe('slow');
      expect(imported.handoff).toBe(true);
      expect(imported.metadata.openchamber.work).toEqual({ label: 'w' });
      expect(imported.metadata.openchamber.transferredTo).toBeUndefined();
      expect(imported.metadata.openchamber.transferredFrom).toMatchObject({ hostLabel: 'Mac', sessionId: sourceSession.id });
      const messages = await target.store.getMessages(imported.id);
      expect(messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
      expect(messages.map((message) => message.content)).toEqual(['hello', 'hi']);
    });

    it('announces the new metadata', async () => {
      const bundle = await exportBundle();
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle } });
      const announced = target.events.find((event) => event.type === 'session.metadata.updated' && event.data.sessionID === res.body.data.sessionId);
      expect(announced.data.metadata.openchamber.transferredFrom.sessionId).toBe(sourceSession.id);
    });

    it('does not mark an empty conversation as a handoff', async () => {
      const bundle = { ...(await exportBundle()), messages: [] };
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle } });
      expect((await target.store.getSession(res.body.data.sessionId)).handoff).toBe(false);
    });

    it('falls back to the engine defaults for an unknown model and engine', async () => {
      const bundle = await exportBundle();
      bundle.session.model = 'no-such-model';
      bundle.session.engine = 'no-such-engine';
      bundle.session.permissionMode = 'no-such-mode';
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle } });
      expect(res.status).toBe(201);
      const imported = await target.store.getSession(res.body.data.sessionId);
      expect(imported).toMatchObject({ engine: 'fake', model: 'fast', permissionMode: 'ask', title: 'Moving chat' });
    });

    it('uses the requested cwd', async () => {
      const bundle = await exportBundle();
      const picked = path.join(tmpDir, 'picked');
      fs.mkdirSync(picked);
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle, cwd: picked } });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ matchedBy: 'requested', directory: picked });
    });

    it('matches a saved project by folder name', async () => {
      const projectDir = path.join(tmpDir, 'projects', 'work');
      fs.mkdirSync(projectDir, { recursive: true });
      const host = createHost(tmpDir, 'with-projects', { projects: [{ path: projectDir }] });
      try {
        const bundle = await exportBundle();
        bundle.source.cwd = '/gone/elsewhere/work';
        bundle.source.homeRelativeCwd = null;
        const res = await host.request('/api/sessions/import-transfer', { body: { bundle } });
        expect(res.body.data).toMatchObject({ matchedBy: 'project-name', directory: projectDir });
      } finally {
        await host.close();
      }
    });

    it('applies git changes when asked', async () => {
      const bundle = await exportBundle();
      bundle.git = { branch: null, head: null, remoteUrl: null, repoSubpath: '', diff: '', untracked: [] };
      const plain = path.join(tmpDir, 'plain');
      fs.mkdirSync(plain);
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle, cwd: plain, applyGitChanges: true } });
      expect(res.status).toBe(201);
      expect(res.body.data.gitTransferResult.applied).toBe(false);
      expect(res.body.data.gitTransferResult.warning).toContain('not a git repository');
    });

    it('prompts the imported session and reports it', async () => {
      const bundle = await exportBundle();
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle, prompt: '  continue please  ' } });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ prompted: true, promptError: null });
      await until(() => target.fake.processes[0]?.sent.length > 0);
      expect(target.fake.processes[0].sent[0]).toContain('continue please');
      expect(target.fake.processes[0].sent[0]).toContain('<previous_conversation>');
    });

    it('reports a prompt that fails without failing the import', async () => {
      const bundle = await exportBundle();
      target.fake.startError = new Error('cannot start');
      const res = await target.request('/api/sessions/import-transfer', { body: { bundle, prompt: 'go' } });
      expect(res.status).toBe(201);
      expect(res.body.data.prompted).toBe(false);
      expect(res.body.data.promptError).toBeTruthy();
    });

    it.each([
      ['an empty body', {}],
      ['a wrong version', (bundle) => ({ bundle: { ...bundle, version: 2 } })],
      ['a message without an id', (bundle) => ({ bundle: { ...bundle, messages: [{ role: 'user' }] } })],
      ['a missing source session id', (bundle) => ({ bundle: { ...bundle, source: { hostname: 'x' } } })],
      ['an empty cwd', (bundle) => ({ bundle, cwd: '' })],
    ])('rejects %s with 400', async (_label, makeBody) => {
      const bundle = await exportBundle();
      const body = makeBody instanceof Function ? makeBody(bundle) : makeBody;
      const res = await target.request('/api/sessions/import-transfer', { body });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid transfer');
    });
  });

  describe('POST mark-transferred', () => {
    it('stores transferredTo and keeps the rest of the metadata', async () => {
      const res = await source.request(`/api/sessions/${sourceSession.id}/mark-transferred`, {
        body: { hostLabel: 'PC', runtimeKey: 'pc-1', targetSessionId: 'target-1' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ hostLabel: 'PC', runtimeKey: 'pc-1', targetSessionId: 'target-1' });
      expect(res.body.data.transferredAt).toEqual(expect.any(Number));

      const stored = await source.store.getSession(sourceSession.id);
      expect(stored.metadata.openchamber.transferredTo).toEqual(res.body.data);
      expect(stored.metadata.openchamber.work).toEqual({ label: 'w' });
      expect(source.events.some((event) => event.type === 'session.metadata.updated')).toBe(true);
    });

    it('returns 400 for missing fields', async () => {
      const url = `/api/sessions/${sourceSession.id}/mark-transferred`;
      expect((await source.request(url, { body: { hostLabel: 'PC' } })).status).toBe(400);
      expect((await source.request(url, { body: { targetSessionId: 't' } })).status).toBe(400);
      expect((await source.request(url, { body: { hostLabel: '', targetSessionId: 't' } })).status).toBe(400);
    });

    it('returns 404 for an unknown session', async () => {
      const res = await source.request('/api/sessions/missing/mark-transferred', { body: { hostLabel: 'PC', targetSessionId: 't' } });
      expect(res.status).toBe(404);
    });
  });

  describe('POST auto-resume', () => {
    const url = () => `/api/session/${sourceSession.id}/auto-resume`;

    it('schedules a resume when enabled', async () => {
      const resumeAt = Date.now() + 60 * 60_000;
      const res = await source.request(url(), { body: { enabled: true, resumeAt, prompt: ' carry on ' } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: true, status: 'scheduled', resumeAt, resetWindow: 'user', prompt: 'carry on' });

      const stored = await source.store.getSession(sourceSession.id);
      expect(stored.metadata.openchamber.autoResume).toEqual(res.body.data);
      expect(stored.metadata.openchamber.work).toEqual({ label: 'w' });
    });

    it('waits 30 minutes when enabled without a time', async () => {
      const before = Date.now();
      const res = await source.request(url(), { body: { enabled: true } });
      expect(res.body.data.status).toBe('scheduled');
      expect(res.body.data.resumeAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    });

    it('goes idle when disabled', async () => {
      await source.request(url(), { body: { enabled: true } });
      const res = await source.request(url(), { body: { enabled: false } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: false, status: 'idle' });
    });

    it('rejects a resumeAt in the past', async () => {
      const res = await source.request(url(), { body: { enabled: true, resumeAt: Date.now() - 1000 } });
      expect(res.status).toBe(400);
      expect(res.body.field ?? res.body.error).toBeTruthy();
    });

    it.each([
      ['a missing enabled', {}],
      ['a non-boolean enabled', { enabled: 'yes' }],
      ['a non-integer resumeAt', { enabled: true, resumeAt: 1.5 }],
      ['a non-string prompt', { enabled: true, prompt: 5 }],
    ])('rejects %s with 400', async (_label, body) => {
      expect((await source.request(url(), { body })).status).toBe(400);
    });

    it('returns 404 for an unknown session', async () => {
      expect((await source.request('/api/session/missing/auto-resume', { body: { enabled: true } })).status).toBe(404);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerClaudeEngineRoutes } from './routes.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';

describe('Claude Engine REST Routes', () => {
  let app;
  let tmpDir;
  let store;
  let controlBridge;
  let streamHub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-routes-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    controlBridge = new ControlBridge();
    streamHub = new StreamHub();

    app = express();
    app.use(express.json());

    registerClaudeEngineRoutes(app, {
      store,
      controlBridge,
      streamHub,
      authStatusProvider: async () => ({
        loggedIn: true,
        email: 'test@example.com',
        subscriptionType: 'pro',
      }),
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  const request = async (url, options = {}) => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, options);
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    } finally {
      server.close();
    }
  };

  it('GET /api/health returns engine info', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('claude-code');
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/auth/status returns authentication info', async () => {
    const res = await request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(true);
    expect(res.body.email).toBe('test@example.com');
  });

  it('CRUD /api/sessions creates, reads, and deletes sessions', async () => {
    // 1. Create
    const createRes = await request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Session',
        cwd: 'C:/projects/app',
        model: 'sonnet',
      }),
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeDefined();
    const sessionId = createRes.body.id;

    // 2. List
    const listRes = await request('/api/sessions');
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].id).toBe(sessionId);

    // 3. Get single
    const getRes = await request(`/api/sessions/${sessionId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.title).toBe('New Session');

    // 4. Delete
    const delRes = await request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    const getAfter = await request(`/api/sessions/${sessionId}`);
    expect(getAfter.status).toBe(404);
  });

  it('POST /api/sessions/:id/permission resolves pending requests', async () => {
    const createRes = await request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Perm Test', cwd: 'C:/app' }),
    });
    const sessionId = createRes.body.id;

    // Simulate an ongoing pending control request
    let resolved = null;
    controlBridge.handleControlRequest(sessionId, {
      requestId: 'req-perm-1',
      toolName: 'Bash',
    }, 'manual').then((r) => { resolved = r; });

    const permRes = await request(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'req-perm-1',
        decision: 'allow',
      }),
    });

    expect(permRes.status).toBe(200);
    expect(permRes.body.success).toBe(true);

    // Give microtask tick
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toEqual({ behavior: 'allow' });
  });

  it('serves OpenChamber UI wire endpoints (config, provider, agent, singular /session)', async () => {
    // 1. Config
    const configRes = await request('/api/config');
    expect(configRes.status).toBe(200);
    expect(Array.isArray(configRes.body.data)).toBe(true);

    // 2. Provider
    const providerRes = await request('/api/provider');
    expect(providerRes.status).toBe(200);
    expect(providerRes.body.data[0].id).toBe('anthropic');
    expect(providerRes.body.data[0].models.length).toBeGreaterThan(0);

    // 3. Agent
    const agentRes = await request('/api/agent');
    expect(agentRes.status).toBe(200);
    expect(agentRes.body.data[0].id).toBe('claude');

    // 4. Create session via UI route POST /api/session
    const createUiRes = await request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'UI Session' }),
    });
    expect(createUiRes.status).toBe(200);
    expect(createUiRes.body.data.id).toBeDefined();
    expect(createUiRes.body.data.location.directory).toBeDefined();
    const sid = createUiRes.body.data.id;

    // 5. List sessions via UI route GET /api/session
    const listUiRes = await request('/api/session');
    expect(listUiRes.status).toBe(200);
    expect(Array.isArray(listUiRes.body.data)).toBe(true);
    expect(listUiRes.body.data.some((s) => s.id === sid)).toBe(true);

    // 6. Delete via UI route DELETE /api/session/:id
    const delUiRes = await request(`/api/session/${sid}`, { method: 'DELETE' });
    expect(delUiRes.status).toBe(204);
  });

  it('serves engine status and installer routes', async () => {
    // 1. Engine status
    const statusRes = await request('/api/engine/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.engine).toBe('claude-code');
    expect(typeof statusRes.body.installed).toBe('boolean');
    expect(statusRes.body.canInstall).toBe(true);

    // 2. OpenCode compatibility gate integration
    const compatRes = await request('/api/opencode/compatibility');
    expect(compatRes.status).toBe(200);
    expect(['compatible', 'incompatible']).toContain(compatRes.body.state);
    expect(compatRes.body.installation).toBe('external');
    expect(compatRes.body.canInstall).toBe(true);

    // 3. Config reload
    const reloadRes = await request('/api/config/reload', { method: 'POST' });
    expect(reloadRes.status).toBe(200);
    expect(reloadRes.body.success).toBe(true);
  });
});


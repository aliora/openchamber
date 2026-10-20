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

// The fake engine answers by prompt text, so each test drives the state it needs.
const answer = (text, proc) => {
  if (text === 'needs approval') {
    proc.emit('permission.requested', { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } });
    return;
  }
  if (text === 'needs input') {
    proc.emit('question.requested', { requestId: 'qst-1', questions: [{ id: 'q0', question: 'Which color?', options: [] }] });
    return;
  }
  if (text === 'keep working') return;
  if (text === 'break') {
    proc.emit('turn.completed', { outcome: 'failed' });
    return;
  }
  proc.emit('text.delta', { text: `echo: ${text}` });
  proc.emit('turn.completed', { outcome: 'succeeded' });
};

// Reads the summary stream: `next(predicate)` resolves with the first event that matches.
const openSummaryStream = async (url) => {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const comments = [];
  let buffer = '';
  const pump = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended');
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        if (line.startsWith(':')) comments.push(line);
      }
      boundary = buffer.indexOf('\n\n');
    }
  };
  let seen = 0;
  return {
    response,
    comments,
    async next(predicate = () => true) {
      for (;;) {
        while (seen < events.length) {
          const event = events[seen];
          seen += 1;
          if (predicate(event)) return event;
        }
        await pump();
      }
    },
    async waitForComment() {
      while (comments.length === 0) await pump();
      return comments[0];
    },
    close: () => controller.abort(),
  };
};

describe('session summary routes', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let fake;
  let streams;
  let routes;
  let projectSettings;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-summary-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    fake = createFakeEngine({ id: 'fake', reply: answer });
    const app = express();
    app.use(express.json());
    projectSettings = {};
    routes = registerEngineRoutes(app, {
      registry: createEngineRegistry([fake, createFakeEngine({ id: 'other', reply: answer })]),
      store,
      controlBridge: new ControlBridge(),
      streamHub: new StreamHub(),
      summaryHeartbeatMs: 50,
      chatRoots: ['/data/chats'],
      readSettings: async () => projectSettings,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    streams = [];
  });

  afterEach(() => {
    for (const stream of streams) stream.close();
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
  const createSession = async (title) => (await request('/api/session', { body: { title, engine: 'fake', location: { directory: '/work/app' } } })).body.data.id;
  const summaryOf = async (id) => (await request('/api/sessions/summary')).body.sessions.find((row) => row.id === id);
  const stream = async () => {
    const opened = await openSummaryStream(`${baseUrl}/api/sessions/summary/stream`);
    streams.push(opened);
    return opened;
  };

  it('lists every session as a compact row, before the session-id route can claim the path', async () => {
    expect((await request('/api/sessions/summary')).body).toEqual({ sessions: [], projects: [] });

    const id = await createSession('First');
    await store.createSession({ title: 'Gone engine', engine: 'removed', cwd: '/elsewhere' });
    const res = await request('/api/sessions/summary');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    const [row] = res.body.sessions;
    expect(row).toEqual({
      id,
      title: 'First',
      directory: '/work/app',
      engine: 'fake',
      updatedAt: expect.any(Number),
      state: 'idle',
      projectId: null,
      work: null,
    });
  });

  it('lists the projects in their saved order and places each session in the deepest project holding its folder', async () => {
    projectSettings = {
      projects: [
        { id: 'work', path: '/work', label: 'Work' },
        { id: 'app', path: '/work/app' },
        { id: 'site', path: '/sites/site', label: '  ' },
      ],
      defaultProjectId: 'app',
    };
    const at = async (directory) => (await request('/api/session', { body: { engine: 'fake', location: { directory } } })).body.data.id;
    const inApp = await at('/work/app/packages/web');
    const atApp = await at('/work/app');
    const inWork = await at('/work/notes');
    const lookalike = await at('/work/application');
    const outside = await at('/elsewhere');

    const body = (await request('/api/sessions/summary')).body;
    expect(body.projects).toEqual([
      { id: 'work', label: 'Work', path: '/work', order: 0, isDefault: false },
      { id: 'app', label: 'app', path: '/work/app', order: 1, isDefault: true },
      { id: 'site', label: 'site', path: '/sites/site', order: 2, isDefault: false },
    ]);
    const projectOf = (id) => body.sessions.find((row) => row.id === id).projectId;
    expect(projectOf(inApp)).toBe('app');
    expect(projectOf(atApp)).toBe('app');
    expect(projectOf(inWork)).toBe('work');
    expect(projectOf(lookalike)).toBe('work');
    expect(projectOf(outside)).toBeNull();
  });

  it('answers an empty project list when the settings cannot be read', async () => {
    projectSettings = null;
    const id = await createSession('Orphan');
    const body = (await request('/api/sessions/summary')).body;
    expect(body.projects).toEqual([]);
    expect(body.sessions.find((row) => row.id === id).projectId).toBeNull();
  });

  it('reads running, waiting-permission, waiting-input and the last outcome from the runtime and the bridge', async () => {
    const id = await createSession('Work');

    await request(`/api/session/${id}/prompt`, { body: { text: 'keep working' } });
    await settle();
    expect((await summaryOf(id)).state).toBe('running');

    fake.processes[0].emit('turn.completed', { outcome: 'succeeded' });
    await settle();
    expect(await summaryOf(id)).toMatchObject({ state: 'idle', outcome: 'succeeded' });

    await request(`/api/session/${id}/prompt`, { body: { text: 'needs approval' } });
    await settle();
    expect((await summaryOf(id)).state).toBe('waiting-permission');

    await request(`/api/session/${id}/permission/req-1/reply`, { body: { decision: 'once' } });
    await settle();
    expect((await summaryOf(id)).state).toBe('running');

    await request(`/api/session/${id}/prompt`, { body: { text: 'needs input' } });
    await settle();
    expect((await summaryOf(id)).state).toBe('waiting-input');

    await request(`/api/session/${id}/form/qst-1/reply`, { body: { answer: { q0: 'Blue' } } });
    await settle();
    expect((await summaryOf(id)).state).toBe('running');

    await request(`/api/session/${id}/abort`, { body: {} });
    expect(await summaryOf(id)).toMatchObject({ state: 'idle', outcome: 'interrupted' });
  });

  it('marks a session whose folder is inside a chats root as a chat', async () => {
    const at = async (directory) => (await request('/api/session', { body: { engine: 'fake', location: { directory } } })).body.data.id;
    const chat = await at('/data/chats/2026-10-16/session-1');
    const project = await at('/work/app');
    const lookalike = await at('/data/chats-old/app');
    expect((await summaryOf(chat)).chat).toBe(true);
    expect(await summaryOf(project)).not.toHaveProperty('chat');
    expect(await summaryOf(lookalike)).not.toHaveProperty('chat');
  });

  it('reads the work state from the session metadata, open or nothing', async () => {
    const id = await createSession('Tracked');
    const setMetadata = (metadata) => request(`/api/session/${id}`, { method: 'PATCH', body: { metadata } });

    await setMetadata({ openchamber: { work: { state: 'open', openedAt: 1, openedBy: 'user' } } });
    expect((await summaryOf(id)).work).toBe('open');

    await setMetadata({ openchamber: { work: { state: 'done', doneAt: 2 } } });
    expect((await summaryOf(id)).work).toBeNull();

    await setMetadata({ openchamber: { work: { state: 'started' } } });
    expect((await summaryOf(id)).work).toBeNull();
  });

  it('streams a row when only the work state changes', async () => {
    const id = await createSession('Tracked');
    const live = await stream();
    expect((await live.next()).sessions[0].work).toBeNull();

    await request(`/api/session/${id}`, { method: 'PATCH', body: { metadata: { openchamber: { work: { state: 'open' } } } } });
    expect((await live.next((event) => event.type === 'session')).session).toMatchObject({ id, work: 'open' });

    await request(`/api/session/${id}`, { method: 'PATCH', body: { metadata: { openchamber: { work: { state: 'done' } } } } });
    expect((await live.next((event) => event.type === 'session')).session).toMatchObject({ id, work: null });
  });

  it('keeps a failed turn as failed until the next turn starts', async () => {
    const id = await createSession('Fragile');
    await request(`/api/session/${id}/prompt`, { body: { text: 'break' } });
    await settle();
    expect(await summaryOf(id)).toMatchObject({ state: 'failed', outcome: 'failed' });

    await request(`/api/session/${id}/prompt`, { body: { text: 'keep working' } });
    await settle();
    expect(await summaryOf(id)).toMatchObject({ state: 'running', outcome: 'failed' });
  });

  it('streams a snapshot first, then state, title, creation and removal changes', async () => {
    const existing = await createSession('Existing');
    const live = await stream();
    expect(live.response.headers.get('content-type')).toContain('text/event-stream');

    const snapshot = await live.next();
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.sessions.map((row) => row.id)).toEqual([existing]);
    expect(snapshot.projects).toEqual([]);

    await request(`/api/session/${existing}/prompt`, { body: { text: 'needs approval' } });
    expect((await live.next((event) => event.session?.state === 'running')).session.id).toBe(existing);
    expect((await live.next((event) => event.session?.state === 'waiting-permission')).session.id).toBe(existing);

    await request(`/api/session/${existing}`, { method: 'PATCH', body: { title: 'Renamed' } });
    expect((await live.next((event) => event.session?.title === 'Renamed')).session.state).toBe('waiting-permission');

    const created = await createSession('Second');
    expect((await live.next((event) => event.session?.id === created)).session).toMatchObject({ title: 'Second', state: 'idle' });

    // Picking another engine's model moves a chat without messages to that engine.
    await request(`/api/session/${created}/model`, { body: { model: { providerID: 'other-provider', id: 'slow' } } });
    expect((await live.next((event) => event.session?.id === created && event.session.engine === 'other')).session.state).toBe('idle');

    await request(`/api/session/${created}`, { method: 'DELETE' });
    expect(await live.next((event) => event.type === 'removed')).toEqual({ type: 'removed', id: created });
  });

  it('sends a fresh snapshot when the project list changes, and later rows carry the new project', async () => {
    const existing = await createSession('Existing');
    const live = await stream();
    expect((await live.next()).sessions[0].projectId).toBeNull();

    projectSettings = { projects: [{ id: 'app', path: '/work/app', label: 'App' }] };
    await routes.summary.refreshProjects();
    const refreshed = await live.next((event) => event.type === 'snapshot');
    expect(refreshed.projects).toEqual([{ id: 'app', label: 'App', path: '/work/app', order: 0, isDefault: false }]);
    expect(refreshed.sessions).toEqual([expect.objectContaining({ id: existing, projectId: 'app' })]);

    await request(`/api/session/${existing}`, { method: 'PATCH', body: { title: 'Renamed' } });
    expect((await live.next((event) => event.session?.title === 'Renamed')).session.projectId).toBe('app');
  });

  it('sends a heartbeat comment on a quiet stream', async () => {
    const live = await stream();
    await live.next();
    expect(await live.waitForComment()).toBe(': heartbeat');
  });

  it('carries no message content', async () => {
    const id = await createSession('Private');
    await request(`/api/session/${id}/prompt`, { body: { text: 'secret plan' } });
    await settle();
    const raw = JSON.stringify((await request('/api/sessions/summary')).body);
    expect(raw).not.toContain('secret plan');
    expect(raw).not.toContain('echo:');
  });
});

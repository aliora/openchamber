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

const LIMIT_TEXT = "You've hit your limit · resets in 2 hours";

describe('automatic resume after a usage limit', () => {
  let tmpDir;
  let store;
  let fake;
  let events;
  let engineRoutes;
  let server;
  let baseUrl;
  let limited;

  const request = async (url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const until = async (check) => {
    for (let attempt = 0; attempt < 100 && !(await check()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const autoResumeOf = async (sessionId) => (await store.getSession(sessionId)).metadata?.openchamber?.autoResume;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auto-resume-routes-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    limited = true;
    fake = createFakeEngine({
      reply: (text, proc) => {
        if (limited) {
          proc.emit('turn.completed', { outcome: 'failed', usage: {}, error: { type: 'EngineTurnFailed', message: LIMIT_TEXT } });
          return;
        }
        proc.emit('text.delta', { text: `echo: ${text}` });
        proc.emit('turn.completed', { outcome: 'succeeded', usage: { input: 1, output: 1 } });
      },
    });
    const streamHub = new StreamHub();
    events = [];
    const broadcast = streamHub.broadcast.bind(streamHub);
    streamHub.broadcast = (sessionId, event) => {
      events.push(event);
      broadcast(sessionId, event);
    };
    const app = express();
    app.use(express.json());
    engineRoutes = registerEngineRoutes(app, { registry: createEngineRegistry([fake]), store, controlBridge: new ControlBridge(), streamHub });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await engineRoutes.shutdown();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records when the limit lifts after a turn fails on it, with the switch off', async () => {
    const session = await store.createSession({ engine: 'fake', cwd: tmpDir });
    const before = Date.now();

    expect((await request(`/api/session/${session.id}/prompt`, { text: 'work' })).status).toBe(200);
    await until(async () => Boolean(await autoResumeOf(session.id)));

    const state = await autoResumeOf(session.id);
    expect(state).toMatchObject({ enabled: false, status: 'idle', resetWindow: 'error' });
    expect(state.resumeAt).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000);
    expect(events.some((event) => event.type === 'session.metadata.updated' && event.data.sessionID === session.id)).toBe(true);
  });

  it('schedules the resume when the switch is on, and a user prompt cancels it', async () => {
    const session = await store.createSession({ engine: 'fake', cwd: tmpDir });
    await request(`/api/session/${session.id}/auto-resume`, { enabled: true });

    await request(`/api/session/${session.id}/prompt`, { text: 'work' });
    await until(async () => (await autoResumeOf(session.id))?.resetWindow === 'error');
    expect(await autoResumeOf(session.id)).toMatchObject({ enabled: true, status: 'scheduled' });

    limited = false;
    await request(`/api/session/${session.id}/prompt`, { text: 'I am back' });
    expect(await autoResumeOf(session.id)).toMatchObject({ enabled: true, status: 'idle', resumeAt: null });
  });

  it('prompts the session by itself once the time comes', async () => {
    const session = await store.createSession({ engine: 'fake', cwd: tmpDir });
    await request(`/api/session/${session.id}/prompt`, { text: 'work' });
    await until(async () => Boolean(await autoResumeOf(session.id)));
    limited = false;

    const scheduled = await request(`/api/session/${session.id}/auto-resume`, { enabled: true, resumeAt: Date.now() + 100, prompt: 'Carry on' });
    expect(scheduled.body.data).toMatchObject({ status: 'scheduled', resetWindow: 'user', prompt: 'Carry on' });

    await until(async () => (await autoResumeOf(session.id))?.status === 'idle');
    const sent = fake.processes.flatMap((proc) => proc.sent);
    expect(sent.at(-1)).toBe('Carry on');
    expect(await autoResumeOf(session.id)).toMatchObject({ enabled: true, status: 'idle', resumeAt: null });
  });
});

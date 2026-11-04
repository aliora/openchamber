import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { EventEmitter } from 'node:events';
import { OpenCode } from '@opencode/client';
import { createOpenCodeEngine } from '../packages/web/server/lib/engine/opencode/adapter.js';
import { createFakeEngine } from '../packages/web/server/lib/engine/test/fake-engine.js';
import { createEngineRegistry } from '../packages/web/server/lib/engine/registry.js';
import { registerEngineRoutes } from '../packages/web/server/lib/engine/routes.js';
import { LocalSessionStore } from '../packages/web/server/lib/engine/store.js';
import { StreamHub } from '../packages/web/server/lib/engine/stream-hub.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-opencode-e2e-'));
const store = new LocalSessionStore({ storagePath: path.join(directory, 'sessions.json') });
const bus = new EventEmitter();
const wait = (type) => new Promise((resolve, reject) => {
  const receive = (event) => { clearTimeout(timer); resolve(event); };
  const timer = setTimeout(() => { bus.off(type, receive); reject(new Error(`Timed out waiting for ${type}`)); }, 45000);
  bus.once(type, receive);
});
let liveProcess;
const start = () => {
  const engine = createOpenCodeEngine();
  const createProcess = engine.createProcess;
  engine.createProcess = (options) => { liveProcess = createProcess(options); return liveProcess; };
  const app = express(); app.use(express.json());
  const streamHub = new StreamHub();
  const broadcast = streamHub.broadcast.bind(streamHub);
  streamHub.broadcast = (id, event) => { bus.emit(event.type, event); broadcast(id, event); };
  const runtime = registerEngineRoutes(app, { registry: createEngineRegistry([createFakeEngine({ id: 'claude' }), engine]), store, streamHub });
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = OpenCode.make({ baseUrl, headers: { 'x-opencode-directory': encodeURIComponent(directory) } });
    resolve({ engine, baseUrl, client, stop: async () => { await runtime.shutdown(); server.closeAllConnections(); await new Promise((done) => server.close(done)); } });
  }));
};

let running = await start();
try {
  const catalog = await running.client.model.list({ location: { directory } });
  assert(catalog.data.some((model) => model.providerID === 'opencode'));
  const model = running.engine.modelCatalog(directory).defaultModel;
  const session = await running.client.session.create({ title: 'Fourth engine E2E', location: { directory }, model: { providerID: 'opencode', id: model } });
  let terminal = wait('session.execution.succeeded');
  await running.client.session.prompt({ sessionID: session.id, text: 'Reply FIRST_OK only. Do not read files or use tools.' });
  await terminal;
  assert((await store.getMessages(session.id)).some((message) => message.role === 'assistant' && message.content.includes('FIRST_OK')));
  const upstreamId = (await store.getSession(session.id)).engineState.sessionId;

  const formEvent = wait('form.created');
  await liveProcess.client.session.form.create({ sessionID: upstreamId, title: 'Test choice', fields: [{ key: 'choice', type: 'string', required: true }] });
  const form = (await formEvent).data.form;
  const forms = await running.client.form.list({ location: { directory } });
  assert(forms.data.some((item) => item.id === form.id && item.sessionID === session.id), JSON.stringify({ form, forms, cwd: (await store.getSession(session.id)).cwd, directory }));
  assert.equal((await running.client.session.form.get({ sessionID: session.id, formID: form.id })).state.status, 'pending');
  assert.equal((await running.client.session.form.list({ sessionID: session.id })).length, 1);
  const summary = await (await fetch(`${running.baseUrl}/api/sessions/summary`)).json();
  assert.equal(summary.sessions.find((row) => row.id === session.id).state, 'waiting-input');
  await running.client.session.form.reply({ sessionID: session.id, formID: form.id, answer: { choice: 'yes' } });

  const permissionEvent = wait('permission.asked');
  await liveProcess.client.permission.create({ sessionID: upstreamId, action: `probe_${Date.now()}`, resources: ['test'] });
  const permission = (await permissionEvent).data;
  await running.client.permission.reply({ sessionID: session.id, requestID: permission.id, decision: 'once' });

  await running.stop();
  running = await start();
  terminal = wait('session.execution.succeeded');
  await running.client.session.prompt({ sessionID: session.id, text: 'Reply SECOND_OK only. Do not read files or use tools.' });
  await terminal;
  assert.equal((await store.getSession(session.id)).engineState.sessionId, upstreamId);
  assert((await store.getMessages(session.id)).some((message) => message.role === 'assistant' && message.content.includes('SECOND_OK')));
  const started = wait('session.execution.started');
  const interrupted = wait('session.execution.interrupted');
  await running.client.session.prompt({ sessionID: session.id, text: 'Count slowly from one to one thousand. Do not read files or use tools.' });
  await started;
  await running.client.session.interrupt({ sessionID: session.id });
  await interrupted;
  assert.equal(liveProcess.isAlive, false);
  console.log(JSON.stringify({ catalog: true, prompt: true, persisted: true, formReply: true, permissionReply: true, waitingInput: true, restartResume: true, cancellation: true }));
} finally { await running.stop(); }

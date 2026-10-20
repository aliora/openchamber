import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerEngineRoutes } from './routes.js';
import { createEngineRegistry } from './registry.js';
import { LocalSessionStore } from './store.js';
import { createFakeEngine } from './test/fake-engine.js';
import { createAttachmentStore } from './attachments.js';

const answer = (text, proc) => {
  proc.emit('text.delta', { text: 'seen' });
  proc.emit('turn.completed', { outcome: 'succeeded', usage: { input: 1, output: 1 } });
};

describe('attachment routes', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let store;
  let fake;
  let gate;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attachment-routes-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    fake = createFakeEngine({ id: 'fake', reply: answer });
    gate = (req, res, next) => next();
    const app = express();
    app.use('/api', (req, res, next) => gate(req, res, next));
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([fake]),
      store,
      attachments: createAttachmentStore({ root: path.join(tmpDir, 'attachments'), limits: { image: 16, video: 64, file: 32 } }),
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = async (url, { body, method = body ? 'POST' : 'GET' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const putChunk = (id, offset, bytes) => fetch(`${baseUrl}/api/attachments/${id}?offset=${offset}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });

  const uploadFile = async (name, mime, content) => {
    const begun = await json('/api/attachments', { body: { name, mime, size: Buffer.byteLength(content) } });
    expect(begun.status).toBe(201);
    const put = await putChunk(begun.body.id, 0, Buffer.from(content));
    expect(await put.json()).toEqual({ received: Buffer.byteLength(content), complete: true });
    return begun.body;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('hands uploaded files to the engine with the prompt and keeps them in the history', async () => {
    const id = (await json('/api/session', { body: { engine: 'fake' } })).body.data.id;
    const image = await uploadFile('shot.png', 'image/png', 'png-bytes');
    const video = await uploadFile('clip.mov', 'video/quicktime', 'mov-bytes');

    const prompted = await json(`/api/session/${id}/prompt`, {
      body: { text: 'What is in these?', files: [{ uri: image.uri, name: 'shot.png' }, { uri: video.uri, name: 'clip.mov' }] },
    });
    expect(prompted.status).toBe(200);
    await settle();

    const [proc] = fake.processes;
    expect(proc.sent).toEqual(['What is in these?']);
    const [delivered] = proc.sentAttachments;
    expect(delivered.map(({ kind, mime, name }) => ({ kind, mime, name }))).toEqual([
      { kind: 'image', mime: 'image/png', name: 'shot.png' },
      { kind: 'file', mime: 'video/quicktime', name: 'clip.mov' },
    ]);
    expect(fs.readFileSync(delivered[1].path, 'utf8')).toBe('mov-bytes');
    expect(delivered[1].path.startsWith(path.join(tmpDir, 'attachments', 'sessions', id))).toBe(true);

    const history = await json(`/api/session/${id}/message`);
    const user = history.body.data.find((message) => message.type === 'user');
    expect(user.files).toEqual([
      { data: '', mime: 'image/png', name: 'shot.png', source: { type: 'uri', uri: `/api/session/${id}/attachment/${image.id}` } },
      { data: '', mime: 'video/quicktime', name: 'clip.mov', source: { type: 'uri', uri: `/api/session/${id}/attachment/${video.id}` } },
    ]);

    const served = await fetch(`${baseUrl}/api/session/${id}/attachment/${image.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(await served.text()).toBe('png-bytes');
  });

  it('takes a prompt that is only attachments', async () => {
    const id = (await json('/api/session', { body: { engine: 'fake' } })).body.data.id;
    const file = await uploadFile('notes.txt', 'text/plain', 'hello');
    expect((await json(`/api/session/${id}/prompt`, { body: { files: [{ uri: file.uri }] } })).status).toBe(200);
    expect((await json(`/api/session/${id}/prompt`, { body: {} })).status).toBe(400);
  });

  it('refuses a file over its limit, an unknown attachment and a broken chunk', async () => {
    expect((await json('/api/attachments', { body: { name: 'big.png', mime: 'image/png', size: 17 } })).status).toBe(413);
    expect((await json('/api/attachments', { body: { name: 'x', mime: 'not a type', size: 1 } })).status).toBe(400);

    const begun = await json('/api/attachments', { body: { name: 'a.txt', mime: 'text/plain', size: 4 } });
    expect((await putChunk(begun.body.id, 0, Buffer.from('too long'))).status).toBe(413);
    expect((await putChunk(begun.body.id, 2, Buffer.from('ab'))).status).toBe(409);
    expect((await putChunk('../../sessions', 0, Buffer.from('ab'))).status).toBe(404);

    const id = (await json('/api/session', { body: { engine: 'fake' } })).body.data.id;
    const refused = await json(`/api/session/${id}/prompt`, { body: { text: 'hi', files: [{ uri: begun.body.uri }] } });
    expect(refused.status).toBe(400);
    expect(fake.processes).toHaveLength(0);
    expect((await store.getMessages(id))).toHaveLength(0);
  });

  it('cancels an upload and drops a session\'s files with the session', async () => {
    const begun = await json('/api/attachments', { body: { name: 'a.txt', mime: 'text/plain', size: 4 } });
    expect((await fetch(`${baseUrl}/api/attachments/${begun.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await putChunk(begun.body.id, 0, Buffer.from('abcd'))).status).toBe(404);

    const id = (await json('/api/session', { body: { engine: 'fake' } })).body.data.id;
    const file = await uploadFile('notes.txt', 'text/plain', 'hello');
    await json(`/api/session/${id}/prompt`, { body: { text: 'read', files: [{ uri: file.uri }] } });
    await settle();
    expect(fs.existsSync(path.join(tmpDir, 'attachments', 'sessions', id))).toBe(true);
    await fetch(`${baseUrl}/api/session/${id}`, { method: 'DELETE' });
    expect(fs.existsSync(path.join(tmpDir, 'attachments', 'sessions', id))).toBe(false);
    expect((await fetch(`${baseUrl}/api/session/${id}/attachment/${file.id}`)).status).toBe(404);
  });

  it('sits behind the gate every other /api route sits behind', async () => {
    gate = (req, res) => res.status(401).json({ error: 'Unauthorized' });
    expect((await json('/api/attachments', { body: { name: 'a.txt', mime: 'text/plain', size: 1 } })).status).toBe(401);
    expect((await putChunk('00000000-0000-4000-8000-000000000000', 0, Buffer.from('a'))).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/session/ses_1/attachment/00000000-0000-4000-8000-000000000000`)).status).toBe(401);
  });
});

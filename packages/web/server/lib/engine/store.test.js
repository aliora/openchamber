import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalSessionStore } from './store.js';

describe('LocalSessionStore', () => {
  let tmpDir;
  let storageFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-store-test-'));
    storageFile = path.join(tmpDir, 'sessions.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('creates and retrieves a session', async () => {
    const store = new LocalSessionStore({ storagePath: storageFile });
    const session = await store.createSession({
      title: 'Test Session',
      cwd: 'C:/projects/my-app',
      model: 'sonnet',
      effort: 'medium',
      permissionMode: 'auto',
    });

    expect(session.id).toBeDefined();
    expect(session.title).toBe('Test Session');
    expect(session.cwd).toBe('C:/projects/my-app');
    expect(session.model).toBe('sonnet');

    const fetched = await store.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(session.id);
    expect(fetched.title).toBe('Test Session');
  });

  it('filters sessions by cwd', async () => {
    const store = new LocalSessionStore({ storagePath: storageFile });
    await store.createSession({ title: 'Proj 1', cwd: 'C:/proj1' });
    await store.createSession({ title: 'Proj 2', cwd: 'C:/proj2' });

    const all = await store.listSessions();
    expect(all.length).toBe(2);

    const proj1Sessions = await store.listSessions({ cwd: 'C:/proj1' });
    expect(proj1Sessions.length).toBe(1);
    expect(proj1Sessions[0].title).toBe('Proj 1');
  });

  it('updates session metadata', async () => {
    const store = new LocalSessionStore({ storagePath: storageFile });
    const session = await store.createSession({ title: 'Original', cwd: 'C:/test' });

    const updated = await store.updateSession(session.id, {
      title: 'Renamed',
      model: 'opus',
    });

    expect(updated.title).toBe('Renamed');
    expect(updated.model).toBe('opus');

    const refetched = await store.getSession(session.id);
    expect(refetched.title).toBe('Renamed');
  });

  it('deletes a session', async () => {
    const store = new LocalSessionStore({ storagePath: storageFile });
    const session = await store.createSession({ title: 'To Delete', cwd: 'C:/test' });

    const deleted = await store.deleteSession(session.id);
    expect(deleted).toBe(true);

    const refetched = await store.getSession(session.id);
    expect(refetched).toBeNull();
  });

  it('appends messages and parts and survives reload', async () => {
    const store = new LocalSessionStore({ storagePath: storageFile });
    const session = await store.createSession({ title: 'Chat', cwd: 'C:/test' });

    await store.appendMessage(session.id, {
      id: 'msg-1',
      role: 'user',
      content: 'Explain code',
      createdAt: Date.now(),
      parts: [{ type: 'text', content: 'Explain code' }],
    });

    await store.appendMessage(session.id, {
      id: 'msg-2',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        { type: 'reasoning', content: 'Analyzing...' },
        { type: 'text', content: 'Here is the explanation.' },
      ],
    });

    // Reopen store from same file
    const store2 = new LocalSessionStore({ storagePath: storageFile });
    const messages = await store2.getMessages(session.id);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].parts.length).toBe(2);
    expect(messages[1].parts[0].type).toBe('reasoning');
  });
});

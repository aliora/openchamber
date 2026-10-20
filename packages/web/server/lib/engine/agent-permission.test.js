import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentPermissionControl } from './agent-permission.js';
import { createClaudeEngine } from './claude/adapter.js';
import { createEngineRegistry } from './registry.js';
import { LocalSessionStore } from './store.js';
import { createFakeEngine } from './test/fake-engine.js';

describe('agent permission control', () => {
  let tmpDir;
  let store;
  let applied;
  let control;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-agent-permission-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    const fake = createFakeEngine();
    const claude = createClaudeEngine({ installer: fake.installer, authStatusProvider: async () => ({ loggedIn: false }) });
    applied = [];
    control = createAgentPermissionControl({
      store,
      registry: createEngineRegistry([claude, fake]),
      applyPermissionMode: async ({ session }, mode) => {
        applied.push([session.id, mode]);
        return { session: await store.updateSession(session.id, { permissionMode: mode }) };
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const session = (fields) => store.createSession({ engine: 'claude', ...fields });

  it('changes the mode of a session below the caller within the caller tier', async () => {
    const caller = await session({ permissionMode: 'acceptEdits' });
    const child = await session({ parentID: caller.id, permissionMode: 'manual' });
    const grandchild = await session({ parentID: child.id, permissionMode: 'plan' });

    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: grandchild.id, mode: 'acceptEdits' }))
      .toEqual({ sessionId: grandchild.id, permissionMode: 'acceptEdits' });
    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'plan' }))
      .toEqual({ sessionId: child.id, permissionMode: 'plan' });
    expect(applied).toEqual([[grandchild.id, 'acceptEdits'], [child.id, 'plan']]);
  });

  it('refuses a session that is not below the caller', async () => {
    const caller = await session({ permissionMode: 'auto' });
    const sibling = await session({ permissionMode: 'manual' });
    const result = await control.setByAgent({ callerSessionId: caller.id, sessionId: sibling.id, mode: 'plan' });
    expect(result).toMatchObject({ status: 403, error: expect.stringContaining('sub-session') });
    expect(applied).toEqual([]);
  });

  it('refuses the caller itself', async () => {
    const caller = await session({ permissionMode: 'auto' });
    const result = await control.setByAgent({ callerSessionId: caller.id, sessionId: caller.id, mode: 'plan' });
    expect(result).toMatchObject({ status: 403, error: expect.stringContaining('its own permission mode') });
    expect(applied).toEqual([]);
  });

  it('refuses a mode that allows more than the caller has', async () => {
    const caller = await session({ permissionMode: 'manual' });
    const child = await session({ parentID: caller.id, permissionMode: 'plan' });
    const result = await control.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'bypassPermissions' });
    expect(result).toMatchObject({ status: 403, error: expect.stringContaining('manual') });
    expect((await store.getSession(child.id)).permissionMode).toBe('plan');
  });

  it('compares modes of different engines by tier', async () => {
    const caller = await session({ permissionMode: 'manual' });
    const child = await session({ engine: 'fake', parentID: caller.id, permissionMode: 'ask' });
    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'yolo' }))
      .toMatchObject({ status: 403 });
    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'ask' }))
      .toEqual({ sessionId: child.id, permissionMode: 'ask' });
  });

  it('refuses a mode the session engine does not have, and unknown sessions', async () => {
    const caller = await session({ permissionMode: 'bypassPermissions' });
    const child = await session({ engine: 'fake', parentID: caller.id, permissionMode: 'ask' });
    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: child.id, mode: 'plan' }))
      .toMatchObject({ status: 400, error: expect.stringContaining('ask, yolo') });
    expect(await control.setByAgent({ callerSessionId: caller.id, sessionId: 'missing', mode: 'plan' }))
      .toMatchObject({ status: 404 });
    expect(await control.setByAgent({ callerSessionId: 'missing', sessionId: child.id, mode: 'ask' }))
      .toMatchObject({ status: 403 });
  });

  it('checks a mode for a new sub-session before it exists', async () => {
    const caller = await session({ permissionMode: 'acceptEdits' });
    expect(await control.checkNewSubSession({ callerSessionId: caller.id, mode: 'plan' })).toEqual({});
    expect(await control.checkNewSubSession({ callerSessionId: caller.id, mode: 'ask', providerID: 'fake-provider' })).toEqual({});
    expect(await control.checkNewSubSession({ callerSessionId: caller.id, mode: 'yolo' })).toMatchObject({ status: 403 });
    expect(await control.checkNewSubSession({ callerSessionId: caller.id, mode: 'plan', providerID: 'fake-provider' }))
      .toMatchObject({ status: 400 });
    expect(await control.checkNewSubSession({ callerSessionId: caller.id, mode: 'nothing' })).toMatchObject({ status: 400 });
    expect(await control.checkNewSubSession({ callerSessionId: 'missing', mode: 'plan' })).toMatchObject({ status: 403 });
  });
});

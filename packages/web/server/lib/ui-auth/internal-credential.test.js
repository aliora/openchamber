import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { INTERNAL_AUTH_HEADER, hasInternalCredential, internalAuthHeaders, isSelfTarget } from './internal-credential.js';
import { createUiAuth } from './ui-auth.js';
import { createOpenCodeAuthStateRuntime } from '../opencode/auth-state-runtime.js';

describe('internal server credential', () => {
  it('is a random per-process value of at least 32 bytes', () => {
    const value = internalAuthHeaders()[INTERNAL_AUTH_HEADER];
    expect(Buffer.from(value, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(internalAuthHeaders()[INTERNAL_AUTH_HEADER]).toBe(value);
  });

  it('accepts only the exact credential from a loopback peer', () => {
    const loopback = { remoteAddress: '::ffff:127.0.0.1' };
    expect(hasInternalCredential({ headers: internalAuthHeaders(), socket: loopback })).toBe(true);
    expect(hasInternalCredential({ headers: internalAuthHeaders(), socket: { remoteAddress: '::1' } })).toBe(true);
    expect(hasInternalCredential({ headers: { [INTERNAL_AUTH_HEADER]: 'nope' }, socket: loopback })).toBe(false);
    expect(hasInternalCredential({ headers: {}, socket: loopback })).toBe(false);
    expect(hasInternalCredential({ headers: internalAuthHeaders(), socket: { remoteAddress: '10.0.0.5' } })).toBe(false);
  });

  it('treats only this server on loopback as a self target', () => {
    expect(isSelfTarget('http://127.0.0.1:3021', 3021)).toBe(true);
    expect(isSelfTarget('http://localhost:3021', 3021)).toBe(true);
    expect(isSelfTarget('http://[::1]:3021', 3021)).toBe(true);
    expect(isSelfTarget('http://127.0.0.1:4096', 3021)).toBe(false);
    expect(isSelfTarget('https://opencode.example.com:3021', 3021)).toBe(false);
    expect(isSelfTarget('http://192.168.1.56:3021', 3021)).toBe(false);
    expect(isSelfTarget(null, 3021)).toBe(false);
    expect(isSelfTarget('http://127.0.0.1:3021', undefined)).toBe(false);
  });
});

describe('OpenCode auth headers', () => {
  const createRuntime = (isInternalTarget) => createOpenCodeAuthStateRuntime({
    crypto: {},
    process: { env: {} },
    getAuthPassword: () => null,
    setAuthPassword: () => {},
    getAuthSource: () => null,
    setAuthSource: () => {},
    getUserProvidedPassword: () => null,
    syncToHmrState: () => {},
    isInternalTarget,
  });

  it('carries the internal credential only to this server', () => {
    expect(createRuntime(() => true).getOpenCodeAuthHeaders()).toEqual(internalAuthHeaders());
    expect(createRuntime(() => false).getOpenCodeAuthHeaders()).toEqual({});
  });

  it('does not count the internal credential as an OpenCode password', () => {
    expect(createRuntime(() => true).isOpenCodeConnectionSecure()).toBe(false);
  });
});

describe('password-protected server calling itself', () => {
  let server = null;
  let uiAuth = null;

  afterEach(async () => {
    uiAuth?.dispose();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = null;
  });

  it('lets an internal self-call through and keeps outside calls locked', async () => {
    uiAuth = createUiAuth({ password: 'secret' });
    const app = express();
    app.use('/api', (req, res, next) => uiAuth.requireAuth(req, res, next));
    app.get('/api/session', (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const authState = createOpenCodeAuthStateRuntime({
      crypto: {},
      process: { env: {} },
      getAuthPassword: () => null,
      setAuthPassword: () => {},
      getAuthSource: () => null,
      setAuthSource: () => {},
      getUserProvidedPassword: () => null,
      syncToHmrState: () => {},
      isInternalTarget: () => isSelfTarget(baseUrl, server.address().port),
    });

    const internal = await fetch(`${baseUrl}/api/session`, { headers: authState.getOpenCodeAuthHeaders() });
    expect(internal.status).toBe(200);
    expect(await internal.json()).toEqual({ ok: true });

    const outside = await fetch(`${baseUrl}/api/session`, { headers: { accept: 'application/json' } });
    expect(outside.status).toBe(401);
  });
});

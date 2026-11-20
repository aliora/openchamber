import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineAccounts } from '../engine/accounts.js';
import { registerQuotaRoutes } from './routes.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-accounts-'));
  roots.push(root);
  const accounts = new EngineAccounts({ root });
  const handlers = new Map();
  const calls = [];
  const providerListCalls = [];
  registerQuotaRoutes({ get: (route, handler) => handlers.set(route, handler) }, {
    accounts,
    getQuotaProviders: async () => ({
      listConfiguredQuotaProviders: async (optionsByProvider) => {
        providerListCalls.push(optionsByProvider);
        return Object.keys(optionsByProvider ?? {});
      },
      fetchQuotaForProvider: async (providerId, scope) => {
        calls.push({ providerId, scope });
        return { providerId, ok: true, configured: true, usage: { windows: {} } };
      },
    }),
  });
  const request = async (providerId, accountId) => {
    let body;
    let status = 200;
    const res = { json: (next) => { body = next; }, status: (next) => { status = next; return res; } };
    await handlers.get('/api/quota/:providerId')({ params: { providerId }, query: { accountId } }, res);
    return { body, status };
  };
  const requestProviders = async () => {
    let body;
    let status = 200;
    const res = { json: (next) => { body = next; }, status: (next) => { status = next; return res; } };
    await handlers.get('/api/quota/providers')({}, res);
    return { body, status };
  };
  return { accounts, request, requestProviders, calls, providerListCalls };
};

describe('quota account scope', () => {
  it('passes accountId and isolated configDir for an explicit named profile', async () => {
    const f = fixture();
    const profile = f.accounts.create('codex', 'Work');
    const { body } = await f.request('codex', profile.id);
    expect(body).toMatchObject({ accountId: profile.id, ok: true, configured: true });
    expect(f.calls).toEqual([{
      providerId: 'codex',
      scope: { accountId: profile.id, configDir: f.accounts.home('codex', profile.id) },
    }]);
  });

  it('resolves the saved default and permits an explicit ambient profile', async () => {
    const f = fixture();
    const profile = f.accounts.create('claude', 'Personal');
    f.accounts.setDefault('claude', profile.id);
    expect((await f.request('claude')).body).toMatchObject({ accountId: profile.id, ok: true });
    expect(f.calls[0]).toEqual({
      providerId: 'claude',
      scope: { accountId: profile.id, configDir: f.accounts.home('claude', profile.id) },
    });
    expect((await f.request('claude', 'default')).body).toMatchObject({ accountId: 'default', ok: true });
    expect(f.calls[1]).toEqual({ providerId: 'claude', scope: undefined });
  });

  it('passes saved default named account scopes when listing configured providers', async () => {
    const f = fixture();
    const profile = f.accounts.create('claude', 'Personal');
    f.accounts.setDefault('claude', profile.id);
    const { body, status } = await f.requestProviders();
    expect(status).toBe(200);
    expect(body.providers).toEqual(['claude']);
    expect(f.providerListCalls[0]).toEqual({
      claude: { accountId: profile.id, configDir: f.accounts.home('claude', profile.id) },
    });
  });

  it('fails closed when registry metadata is unreadable', async () => {
    const f = fixture();
    fs.writeFileSync(f.accounts.file, '{broken');
    expect((await f.request('codex')).status).toBe(503);
    expect((await f.requestProviders()).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });
});

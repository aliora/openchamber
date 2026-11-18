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
  let reads = 0;
  registerQuotaRoutes({ get: (route, handler) => handlers.set(route, handler) }, {
    accounts,
    getQuotaProviders: async () => ({ fetchQuotaForProvider: async (providerId) => {
      reads++;
      return { providerId, ok: true, configured: true, usage: { windows: {} } };
    } }),
  });
  const request = async (providerId, accountId) => {
    let body;
    let status = 200;
    const res = { json: (next) => { body = next; }, status: (next) => { status = next; return res; } };
    await handlers.get('/api/quota/:providerId')({ params: { providerId }, query: { accountId } }, res);
    return { body, status };
  };
  return { accounts, request, reads: () => reads };
};

describe('quota account scope', () => {
  it('returns unavailable without reading ambient credentials for an explicit named profile', async () => {
    const f = fixture();
    const profile = f.accounts.create('codex', 'Work');
    const { body } = await f.request('codex', profile.id);
    expect(body).toMatchObject({ accountId: profile.id, ok: false, configured: false, usage: null });
    expect(body.error).toContain('unavailable for named accounts');
    expect(f.reads()).toBe(0);
  });

  it('resolves the saved default and permits an explicit ambient profile', async () => {
    const f = fixture();
    const profile = f.accounts.create('claude', 'Personal');
    f.accounts.setDefault('claude', profile.id);
    expect((await f.request('claude')).body.accountId).toBe(profile.id);
    expect(f.reads()).toBe(0);
    expect((await f.request('claude', 'default')).body).toMatchObject({ accountId: 'default', ok: true });
    expect(f.reads()).toBe(1);
  });

  it('fails closed when registry metadata is unreadable', async () => {
    const f = fixture();
    fs.writeFileSync(f.accounts.file, '{broken');
    expect((await f.request('codex')).status).toBe(503);
    expect(f.reads()).toBe(0);
  });
});

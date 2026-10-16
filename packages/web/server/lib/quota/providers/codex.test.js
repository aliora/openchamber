import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota, isConfigured, readCodexCredential } from './codex.js';

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-codex-quota-'));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;

const authPath = path.join(codexHome, 'auth.json');

const writeAuth = (value) => fs.writeFileSync(authPath, typeof value === 'string' ? value : JSON.stringify(value));

const signedIn = (tokens = {}) => ({
  OPENAI_API_KEY: null,
  tokens: { id_token: 'id-jwt', access_token: 'test-token', refresh_token: 'refresh-token', account_id: 'acct-1', ...tokens },
  last_refresh: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  writeAuth(signedIn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  fs.rmSync(codexHome, { recursive: true, force: true });
});

const mockUsage = (rateLimit) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate_limit: rateLimit }),
  }));
};

describe('Codex credential', () => {
  it('reads the access token and account id from the Codex CLI auth file', () => {
    expect(readCodexCredential()).toEqual({ accessToken: 'test-token', accountId: 'acct-1' });
    expect(isConfigured()).toBe(true);
  });

  it('sends the Codex sign-in to the usage endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rate_limit: null }) });
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.headers['ChatGPT-Account-Id']).toBe('acct-1');
  });

  it('omits the account header when the sign-in carries no account id', async () => {
    writeAuth(signedIn({ account_id: undefined }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rate_limit: null }) });
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('ChatGPT-Account-Id');
  });

  it.each([
    ['a missing file', () => fs.rmSync(authPath, { force: true })],
    ['an API-key login without tokens', () => writeAuth({ OPENAI_API_KEY: 'sk-test', tokens: null })],
    ['a blank access token', () => writeAuth(signedIn({ access_token: '  ' }))],
    ['an empty file', () => writeAuth('')],
  ])('reports not configured for %s, without a request', async (_name, arrange) => {
    arrange();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isConfigured()).toBe(false);
    const result = await fetchQuota();

    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not configured for malformed JSON and never logs the file contents', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeAuth('{"tokens": {"access_token": "secret-token-value"');

    expect(isConfigured()).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token-value');
  });
});

describe('Codex quota windows', () => {
  it.each([
    { balance: 62500, unlimited: false, expected: '62500' },
    { balance: '62500.00', unlimited: false, expected: '62500' },
    { balance: 12.3456, unlimited: false, expected: '12.3456' },
    { balance: '12.3456', unlimited: false, expected: '12.3456' },
    { balance: 0, unlimited: false, expected: '0' },
    { balance: null, unlimited: true, expected: 'Unlimited' },
    { balance: 62500, unlimited: true, expected: 'Unlimited' },
    { balance: null, unlimited: false, expected: undefined },
    { balance: 'invalid', unlimited: false, expected: undefined },
  ])('displays credit balance $balance with unlimited=$unlimited as $expected', async ({ balance, unlimited, expected }) => {
    vi.stubGlobal('fetch', async () => Response.json({ credits: { balance, unlimited } }));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe(expected);
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
  });

  it('omits the balance window when credits are absent', async () => {
    mockUsage(null);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('labels a weekly-only primary window from its duration', async () => {
    mockUsage({
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: 1784491827,
      },
      secondary_window: null,
    });

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(3);
    expect(result.usage.windows['5h']).toBeUndefined();
  });

  it('labels five-hour and weekly windows from their durations', async () => {
    mockUsage({
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    });

    const result = await fetchQuota();

    expect(result.usage.windows['5h'].usedPercent).toBe(10);
    expect(result.usage.windows.weekly.usedPercent).toBe(20);
  });

  it('surfaces spend_control individual limit for business accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          individual_limit: {
            limit: '7500',
            used: '2674.8724080324173',
            remaining: '4825.127591967583',
            used_percent: 36,
            remaining_percent: 64
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.usedPercent).toBe(36);
    expect(result.usage.windows.credits.valueLabel).toBe('2675 / 7500 used');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('asks the user to sign in to Codex again on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Codex session expired. Open Codex to sign in again.');
  });

  it('reports other HTTP failures with their status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API error: 503');
  });
});

import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchQuotaForProvider, listConfiguredQuotaProviders, readClaudeCredential } from './quotaProviders';

type MockResponseInit = { ok?: boolean; status?: number };

// The providers read the logins the engines' CLIs keep on disk; point both at
// temporary directories so no test touches the real ones.
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-quota-'));
const claudeConfigDirectory = path.join(temporaryDirectory, 'claude');
const codexHomeDirectory = path.join(temporaryDirectory, 'codex');
const claudeCredentialsPath = path.join(claudeConfigDirectory, '.credentials.json');
const codexAuthPath = path.join(codexHomeDirectory, 'auth.json');
const homeDirectory = path.join(temporaryDirectory, 'home');

const previousEnvironment = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  CODEX_HOME: process.env.CODEX_HOME,
  HOME: process.env.HOME,
};

const restoreEnvironment = () => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const claudeCodeBlob = (accessToken: string, expiresAt = Date.now() + 3_600_000) => JSON.stringify({
  mcpOAuth: { 'linear|abc': { accessToken: 'unrelated-mcp-token' } },
  claudeAiOauth: {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt,
    subscriptionType: 'max',
  },
});

const signInClaude = (accessToken: string, expiresAt?: number) => {
  fs.mkdirSync(claudeConfigDirectory, { recursive: true });
  fs.writeFileSync(claudeCredentialsPath, claudeCodeBlob(accessToken, expiresAt));
};

type CodexAuthFile = {
  OPENAI_API_KEY: string | null;
  tokens: Record<string, string> | null;
  last_refresh?: string;
};

const codexSignIn = (tokens: Record<string, string> = {}): CodexAuthFile => ({
  OPENAI_API_KEY: null,
  tokens: { id_token: 'id-jwt', access_token: 'codex-token', refresh_token: 'codex-refresh', account_id: 'acct-1', ...tokens },
  last_refresh: '2026-10-01T00:00:00Z',
});

const signInCodex = (auth: CodexAuthFile | string = codexSignIn()) => {
  fs.mkdirSync(codexHomeDirectory, { recursive: true });
  fs.writeFileSync(codexAuthPath, typeof auth === 'string' ? auth : JSON.stringify(auth));
};

const mockResponse = (body: unknown, init: MockResponseInit = {}): Response => ({
  ok: 'ok' in init ? init.ok! : true,
  status: init.status ?? 200,
  json: async () => body,
} as unknown as Response);

let ORIGINAL_FETCH: typeof globalThis.fetch;

beforeEach(() => {
  ORIGINAL_FETCH = globalThis.fetch;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
  process.env.CODEX_HOME = codexHomeDirectory;
  process.env.HOME = homeDirectory;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  fs.rmSync(claudeConfigDirectory, { recursive: true, force: true });
  fs.rmSync(codexHomeDirectory, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

after(() => {
  restoreEnvironment();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const stubFetchReturning = (resolver: (url: string, init?: RequestInit) => Promise<unknown>): void => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    resolver(String(input), init)) as typeof fetch;
};

describe('quota dispatch', () => {
  test('answers an unknown provider id as unsupported, including names Object.prototype owns', async () => {
    for (const providerId of ['openrouter', 'constructor', 'toString']) {
      const result = await fetchQuotaForProvider(providerId);
      assert.equal(result.ok, false);
      assert.equal(result.configured, false);
      assert.equal(result.error, 'Unsupported provider');
    }
  });

  test('lists only the engines whose CLI is signed in', async () => {
    assert.deepEqual(await listConfiguredQuotaProviders(), []);

    signInClaude('list-claude-token');
    assert.deepEqual(await listConfiguredQuotaProviders(), ['claude']);

    signInCodex();
    assert.deepEqual(await listConfiguredQuotaProviders(), ['claude', 'codex']);
  });

  test('reports a provider without a login as not configured and never calls the network', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return mockResponse({});
    }) as typeof fetch;

    for (const providerId of ['claude', 'codex']) {
      const result = await fetchQuotaForProvider(providerId);
      assert.equal(result.configured, false);
      assert.equal(result.ok, false);
      assert.equal(result.usage, null);
    }
    assert.equal(requests, 0);
  });
});

describe('Claude credential discovery', () => {
  const keychainWith = (accessToken: string) => async () => claudeCodeBlob(accessToken);

  test('prefers the macOS Keychain over a stale credentials file', async () => {
    signInClaude('file-token');

    const credential = await readClaudeCredential({ platform: 'darwin', readKeychain: keychainWith('keychain-token') });

    assert.equal(credential?.accessToken, 'keychain-token');
    assert.equal(credential?.refreshToken, 'keychain-token-refresh');
    assert.equal(credential?.planLabel, 'max');
  });

  test('falls back to the credentials file when the Keychain has no entry', async () => {
    signInClaude('file-token');

    const credential = await readClaudeCredential({ platform: 'darwin', readKeychain: async () => null });

    assert.equal(credential?.accessToken, 'file-token');
  });

  test('never asks the Keychain outside macOS', async () => {
    signInClaude('file-token');
    let asked = false;

    const credential = await readClaudeCredential({
      platform: 'linux',
      readKeychain: async () => {
        asked = true;
        return claudeCodeBlob('keychain-token');
      },
    });

    assert.equal(asked, false);
    assert.equal(credential?.accessToken, 'file-token');
  });

  test('falls back to CLAUDE_CODE_OAUTH_TOKEN last, without a refresh token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

    const credential = await readClaudeCredential({ platform: 'linux' });

    assert.deepEqual(credential, { accessToken: 'env-token', refreshToken: null, expiresAt: null, planLabel: null });
  });

  test('ignores a blob that only holds unrelated MCP tokens', async () => {
    fs.mkdirSync(claudeConfigDirectory, { recursive: true });
    fs.writeFileSync(claudeCredentialsPath, JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'unrelated' } } }));

    assert.equal(await readClaudeCredential({ platform: 'linux' }), null);
  });

  test('reports no login for invalid JSON without logging its text', async () => {
    fs.mkdirSync(claudeConfigDirectory, { recursive: true });
    fs.writeFileSync(claudeCredentialsPath, '{"claudeAiOauth": {"accessToken": "secret-token-value"');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      assert.equal(await readClaudeCredential({ platform: 'linux' }), null);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('secret-token-value'));
  });
});

describe('Claude quota provider (VS Code parity)', () => {
  test('parses current limits, model-scoped limits, extra usage, and the plan', async () => {
    signInClaude('limits-token');
    stubFetchReturning(() => Promise.resolve(mockResponse({
      limits: [
        { kind: 'session', percent: 12, resets_at: '2026-08-20T12:00:00Z', scope: null },
        { kind: 'weekly_all', percent: 34, resets_at: '2026-08-24T12:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 56, resets_at: '2026-08-24T12:00:00Z', scope: { model: { display_name: 'Sonnet' } } },
      ],
      spend: {
        enabled: true,
        percent: 25,
        used: { amount_minor: 2500, exponent: 2, currency: 'USD' },
        limit: { amount_minor: 10000, exponent: 2, currency: 'USD' },
      },
    })));

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.ok, true);
    assert.equal(result.planLabel, 'max');
    assert.equal(result.usage?.windows['5h']?.usedPercent, 12);
    assert.equal(result.usage?.windows['7d']?.usedPercent, 34);
    assert.equal(result.usage?.models?.Sonnet?.windows['7d']?.usedPercent, 56);
    assert.equal(result.usage?.windows.extra_usage?.valueLabel, '$25.00 / $100.00');
  });

  test('sends the Claude Code login to the usage endpoint', async () => {
    signInClaude('header-token');
    let request: { url: string; init?: RequestInit } | undefined;
    stubFetchReturning(async (url, init) => {
      request = { url, init };
      return mockResponse({ limits: [] });
    });

    await fetchQuotaForProvider('claude');

    assert.equal(request?.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.deepEqual(request?.init?.headers, { Authorization: 'Bearer header-token', 'anthropic-beta': 'oauth-2025-04-20' });
  });

  test('keeps serving the last good values while Anthropic rate limits', async () => {
    signInClaude('rate-limit-token');
    const responses = [
      mockResponse({ five_hour: { utilization: 12, resets_at: '2026-08-20T12:00:00Z' } }),
      {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '120' }),
        json: async () => ({}),
      } as Response,
    ];
    let requestCount = 0;
    globalThis.fetch = (async () => {
      const response = responses[requestCount];
      requestCount += 1;
      return response;
    }) as typeof fetch;

    const initial = await fetchQuotaForProvider('claude');
    const rateLimited = await fetchQuotaForProvider('claude');
    const duringCooldown = await fetchQuotaForProvider('claude');

    assert.equal(initial.ok, true);
    assert.equal(rateLimited.ok, true);
    assert.equal(duringCooldown.ok, true);
    assert.equal(duringCooldown.usage?.windows['5h']?.usedPercent, 12);
    assert.equal(requestCount, 2);
  });

  test('never shows one account the cached values of another', async () => {
    signInClaude('first-account-token');
    const responses = [
      mockResponse({ five_hour: { utilization: 12, resets_at: '2026-08-20T12:00:00Z' } }),
      { ok: false, status: 429, headers: new Headers(), json: async () => ({}) } as Response,
    ];
    let requestCount = 0;
    globalThis.fetch = (async () => responses[requestCount++]) as typeof fetch;

    await fetchQuotaForProvider('claude');
    signInClaude('second-account-token');
    const afterSwitch = await fetchQuotaForProvider('claude');

    assert.equal(afterSwitch.ok, false);
    assert.equal(afterSwitch.usage, null);
  });

  test('explains an expired session instead of reporting a bare 401', async () => {
    signInClaude('expired-token');
    stubFetchReturning(() => Promise.resolve(mockResponse({}, { ok: false, status: 401 })));

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.error ?? '', /Claude Code/);
  });

  test('reports an expired token without asking Anthropic', async () => {
    signInClaude('expired-token', Date.now() - 60_000);
    let requested = false;
    stubFetchReturning(() => {
      requested = true;
      return Promise.resolve(mockResponse({}));
    });

    const result = await fetchQuotaForProvider('claude');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Claude session expired. Open Claude Code to sign in again.');
    assert.equal(requested, false);
  });
});

describe('Codex quota provider (VS Code parity)', () => {
  beforeEach(() => {
    signInCodex();
  });

  for (const { balance, unlimited, expected } of [
    { balance: 62500, unlimited: false, expected: '62500' },
    { balance: '62500.00', unlimited: false, expected: '62500' },
    { balance: 12.3456, unlimited: false, expected: '12.3456' },
    { balance: '12.3456', unlimited: false, expected: '12.3456' },
    { balance: 0, unlimited: false, expected: '0' },
    { balance: null, unlimited: true, expected: 'Unlimited' },
    { balance: 62500, unlimited: true, expected: 'Unlimited' },
    { balance: null, unlimited: false, expected: undefined },
    { balance: 'invalid', unlimited: false, expected: undefined },
  ]) {
    test(`displays credit balance ${balance} with unlimited=${unlimited} as ${expected}`, async () => {
      globalThis.fetch = async () => Response.json({ credits: { balance, unlimited } });

      const result = await fetchQuotaForProvider('codex');

      assert.equal(result.ok, true);
      assert.ok(result.usage?.windows.credits_balance);
      assert.equal(result.usage.windows.credits_balance.valueLabel, expected);
      assert.equal(result.usage.windows.credits_balance.usedPercent, null);
    });
  }

  test('sends the Codex CLI login to the usage endpoint', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    stubFetchReturning(async (url, init) => {
      request = { url, init };
      return mockResponse({ rate_limit: null });
    });

    await fetchQuotaForProvider('codex');

    assert.equal(request?.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.deepEqual(request?.init?.headers, {
      Authorization: 'Bearer codex-token',
      'Content-Type': 'application/json',
      'ChatGPT-Account-Id': 'acct-1',
    });
  });

  test('omits the account header when the login carries no account id', async () => {
    signInCodex(codexSignIn({ account_id: '  ' }));
    let headers: RequestInit['headers'];
    stubFetchReturning(async (_url, init) => {
      headers = init?.headers;
      return mockResponse({ rate_limit: null });
    });

    await fetchQuotaForProvider('codex');

    assert.deepEqual(headers, { Authorization: 'Bearer codex-token', 'Content-Type': 'application/json' });
  });

  for (const [name, arrange] of [
    ['a missing file', () => fs.rmSync(codexAuthPath, { force: true })],
    ['an API-key login without tokens', () => signInCodex({ OPENAI_API_KEY: 'sk-test', tokens: null })],
    ['a blank access token', () => signInCodex(codexSignIn({ access_token: '  ' }))],
    ['an empty file', () => signInCodex('')],
  ] as const) {
    test(`reports not configured for ${name}, without a request`, async () => {
      arrange();
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return mockResponse({});
      }) as typeof fetch;

      const result = await fetchQuotaForProvider('codex');

      assert.equal(result.configured, false);
      assert.equal(result.ok, false);
      assert.equal(requests, 0);
    });
  }

  test('asks the user to sign in to Codex again on a 401', async () => {
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Codex session expired. Open Codex to sign in again.');
  });

  test('omits the balance window when credits are absent', async () => {
    globalThis.fetch = async () => Response.json({ rate_limit: null });

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, true);
    assert.ok(result.usage);
    assert.equal(result.usage.windows.credits_balance, undefined);
  });

  test('coalesces concurrent refreshes for the same provider', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let requestCount = 0;
    globalThis.fetch = (() => {
      requestCount += 1;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as typeof fetch;

    const first = fetchQuotaForProvider('codex');
    const second = fetchQuotaForProvider('codex');
    // The request goes out once the credential check settles.
    while (!resolveResponse) await new Promise((resolve) => setImmediate(resolve));
    resolveResponse(mockResponse({ rate_limit: null }));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(requestCount, 1);
  });

  test('surfaces spend_control individual limit for business accounts', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      plan_type: 'business',
      rate_limit: null,
      credits: { has_credits: true, unlimited: false, balance: null },
      spend_control: {
        individual_limit: {
          limit: '7500',
          used: '2674.8724080324173',
          remaining: '4825.127591967583',
          used_percent: 36,
          remaining_percent: 64,
        },
      },
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits!.usedPercent, 36);
    assert.equal(result.usage!.windows.credits!.valueLabel, '2675 / 7500 used');
  });

  test('labels five-hour and weekly windows from their durations', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
      },
    })));

    const result = await fetchQuotaForProvider('codex');

    assert.equal(result.usage?.windows['5h']?.usedPercent, 10);
    assert.equal(result.usage?.windows.weekly?.usedPercent, 20);
  });
});

const agyUsageOutput = {
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-10-24T05:05:05Z' },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-10-18T18:18:15Z' },
            { id: 'broken', window: '5h', remaining_fraction: 'n/a' },
          ],
        },
      ],
    },
  },
};

const agyCreditsOutput = { status: 'SUCCESS', num_turns: 0, command: { name: 'credits', data: { remaining_credits: 12 } } };

let fakeAgyCount = 0;

const installFakeAgy = ({ models = 'Available models:\ngemini-3.8-flash\tGemini 3.8 Flash\n', usage = agyUsageOutput }: { models?: string; usage?: unknown } = {}) => {
  fakeAgyCount += 1;
  const home = path.join(temporaryDirectory, `agy-home-${fakeAgyCount}`);
  const binDirectory = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  const outputs = { models, usage: JSON.stringify(usage), credits: JSON.stringify(agyCreditsOutput) };
  for (const [name, text] of Object.entries(outputs)) fs.writeFileSync(path.join(home, `${name}.out`), text);
  const script = path.join(binDirectory, 'agy');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `dir='${home}'`,
    'if [ "$1" = models ]; then cat "$dir/models.out"; exit 0; fi',
    'case "$2" in /usage) cat "$dir/usage.out" ;; /credits) cat "$dir/credits.out" ;; *) exit 2 ;; esac',
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  process.env.HOME = home;
};

describe('Antigravity quota provider (VS Code parity)', { skip: process.platform === 'win32' }, () => {
  test('is not configured without an agy install', async () => {
    assert.equal(await listConfiguredQuotaProviders().then((ids) => ids.includes('antigravity')), false);
    const result = await fetchQuotaForProvider('antigravity');
    assert.equal(result.configured, false);
  });

  test('is not configured while agy lists no models', async () => {
    installFakeAgy({ models: '' });
    const result = await fetchQuotaForProvider('antigravity');
    assert.equal(result.configured, false);
    assert.equal(result.ok, false);
  });

  test('maps the /usage buckets and /credits balance of a signed-in agy', async () => {
    installFakeAgy();
    assert.ok((await listConfiguredQuotaProviders()).includes('antigravity'));

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, true);
    const windows = result.usage!.windows;
    assert.deepEqual(Object.keys(windows), ['Gemini Models · weekly', 'Gemini Models · 5h', 'credits_balance']);
    assert.equal(windows['Gemini Models · weekly']!.usedPercent, 25);
    assert.equal(windows['Gemini Models · weekly']!.windowSeconds, 604800);
    assert.equal(windows['Gemini Models · 5h']!.usedPercent, 0);
    assert.equal(windows.credits_balance!.valueLabel, '12');
  });

  test('reports unreadable usage as a configured failure', async () => {
    installFakeAgy({ usage: { status: 'SUCCESS', command: { name: 'usage', data: {} } } });
    const result = await fetchQuotaForProvider('antigravity');
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
  });
});

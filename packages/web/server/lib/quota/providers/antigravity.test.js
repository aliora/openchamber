import { describe, expect, it, vi } from 'vitest';

import { createAntigravityQuota } from './antigravity.js';

const usageOutput = {
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9673964381217957, reset_time: '2026-10-24T05:05:05Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-10-18T18:18:15Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.6642547845840454, reset_time: '2026-10-23T07:16:46Z' },
          ],
        },
      ],
    },
  },
};

const creditsOutput = {
  status: 'SUCCESS',
  num_turns: 0,
  command: { name: 'credits', data: { remaining_credits: 0, upgrade_uri: 'https://antigravity.google/g1-upgrade' } },
};

const outputs = { '/usage': usageOutput, '/credits': creditsOutput };

const fakeRun = (overrides = {}) => vi.fn(async (args) => {
  const command = args[1];
  if (command in overrides) return overrides[command];
  return { exitCode: 0, stdout: JSON.stringify(outputs[command]), error: null };
});

const signedIn = () => vi.fn(async () => ({ loggedIn: true, email: null }));

describe('Antigravity quota', () => {
  it('runs the zero-turn /usage and /credits commands in print mode with JSON output', async () => {
    const run = fakeRun();
    await createAntigravityQuota({ run, authStatus: signedIn() }).fetchQuota();

    expect(run).toHaveBeenCalledWith(['-p', '/usage', '--output-format', 'json'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(run).toHaveBeenCalledWith(['-p', '/credits', '--output-format', 'json'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it('maps every bucket of every group to a window named by group and window', async () => {
    const result = await createAntigravityQuota({ run: fakeRun(), authStatus: signedIn() }).fetchQuota();

    expect(result).toMatchObject({ providerId: 'antigravity', providerName: 'Antigravity', ok: true, configured: true });
    const { windows } = result.usage;
    expect(Object.keys(windows)).toEqual([
      'Gemini Models · weekly',
      'Gemini Models · 5h',
      'Claude and GPT models · weekly',
      'credits_balance',
    ]);
    expect(windows['Gemini Models · weekly'].usedPercent).toBeCloseTo(3.26, 2);
    expect(windows['Gemini Models · weekly'].windowSeconds).toBe(7 * 24 * 3600);
    expect(windows['Gemini Models · weekly'].resetAt).toBe(Date.parse('2026-10-24T05:05:05Z'));
    expect(windows['Gemini Models · 5h']).toMatchObject({ usedPercent: 0, windowSeconds: 5 * 3600 });
    expect(windows['Claude and GPT models · weekly'].usedPercent).toBeCloseTo(33.57, 2);
    expect(windows.credits_balance).toMatchObject({ usedPercent: null, valueLabel: '0' });
  });

  it('keeps the limits when the credits command fails', async () => {
    const run = fakeRun({ '/credits': { exitCode: 1, stdout: '', error: null } });
    const result = await createAntigravityQuota({ run, authStatus: signedIn() }).fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance).toBeUndefined();
    expect(Object.keys(result.usage.windows)).toHaveLength(3);
  });

  it('skips a bucket without a usable remaining fraction', async () => {
    const broken = structuredClone(usageOutput);
    broken.command.data.groups[0].buckets[0].remaining_fraction = 'n/a';
    const run = fakeRun({ '/usage': { exitCode: 0, stdout: JSON.stringify(broken), error: null } });
    const result = await createAntigravityQuota({ run, authStatus: signedIn() }).fetchQuota();

    expect(result.usage.windows['Gemini Models · weekly']).toBeUndefined();
    expect(result.usage.windows['Gemini Models · 5h']).toBeDefined();
  });

  it('reports a failed or unreadable /usage as a configured failure without throwing', async () => {
    for (const failure of [
      { exitCode: null, stdout: '', error: new Error('agy -p /usage timed out') },
      { exitCode: 0, stdout: 'not json', error: null },
      { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: {} } }), error: null },
    ]) {
      const run = fakeRun({ '/usage': failure });
      const result = await createAntigravityQuota({ run, authStatus: signedIn() }).fetchQuota();

      expect(result).toMatchObject({ ok: false, configured: true });
      expect(result.error).toEqual(expect.any(String));
    }
  });

  it('is configured only while agy lists models for a signed-in account', async () => {
    const authStatus = vi.fn()
      .mockResolvedValueOnce({ loggedIn: false, email: null, reason: 'not_signed_in' })
      .mockResolvedValueOnce({ loggedIn: true, email: null });
    let time = 0;
    const quota = createAntigravityQuota({ run: fakeRun(), authStatus, now: () => time });

    expect(await quota.isConfigured()).toBe(false);
    time += 61_000;
    expect(await quota.isConfigured()).toBe(true);
  });

  it('never runs a print-mode command without a signed-in account', async () => {
    const run = fakeRun();
    const authStatus = vi.fn(async () => ({ loggedIn: false, email: null, reason: 'not_signed_in' }));
    const result = await createAntigravityQuota({ run, authStatus }).fetchQuota();

    expect(result).toMatchObject({ ok: false, configured: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('caches the sign-in check and the quota for a minute', async () => {
    const run = fakeRun();
    const authStatus = signedIn();
    let time = 0;
    const quota = createAntigravityQuota({ run, authStatus, now: () => time });

    await quota.isConfigured();
    const first = await quota.fetchQuota();
    time += 30_000;
    await quota.isConfigured();
    expect(await quota.fetchQuota()).toBe(first);
    expect(authStatus).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);

    time += 31_000;
    await quota.fetchQuota();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed fetch', async () => {
    const run = fakeRun({ '/usage': { exitCode: null, stdout: '', error: new Error('timed out') } });
    const quota = createAntigravityQuota({ run, authStatus: signedIn() });

    await quota.fetchQuota();
    await quota.fetchQuota();
    expect(run.mock.calls.filter(([args]) => args[1] === '/usage')).toHaveLength(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claude, codex } = vi.hoisted(() => ({
  claude: { providerId: 'claude', providerName: 'Claude', isConfigured: vi.fn(), fetchQuota: vi.fn() },
  codex: { providerId: 'codex', providerName: 'Codex', isConfigured: vi.fn(), fetchQuota: vi.fn() },
}));

vi.mock('./claude/index.js', () => claude);
vi.mock('./codex.js', () => codex);

import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './index.js';

const okResult = (providerId) => ({ providerId, providerName: providerId, ok: true, configured: true, usage: { windows: {} }, fetchedAt: 1 });

beforeEach(() => {
  for (const provider of [claude, codex]) {
    provider.isConfigured.mockReset().mockReturnValue(true);
    provider.fetchQuota.mockReset().mockImplementation(async () => okResult(provider.providerId));
  }
});

describe('quota provider registry', () => {
  it('registers only the engines with a sign-in of their own', async () => {
    expect(listConfiguredQuotaProviders()).toEqual(['claude', 'codex']);
    expect((await fetchQuotaForProvider('openrouter')).error).toBe('Unsupported provider');
  });

  it('lists only the providers whose CLI is signed in', () => {
    codex.isConfigured.mockReturnValue(false);

    expect(listConfiguredQuotaProviders()).toEqual(['claude']);
  });

  it('leaves a provider out of the list when its credential read throws', () => {
    claude.isConfigured.mockImplementation(() => { throw new Error('keychain locked'); });

    expect(listConfiguredQuotaProviders()).toEqual(['codex']);
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider');
    const second = fetchQuotaForProvider('unsupported-test-provider');

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider')).not.toBe(first);
  });
});

describe('quota provider dispatch', () => {
  it('returns the provider result when it has a sign-in', async () => {
    const result = await fetchQuotaForProvider('claude');

    expect(result.ok).toBe(true);
    expect(claude.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('reports a provider without a sign-in as not configured, without fetching', async () => {
    claude.isConfigured.mockReturnValue(false);

    const result = await fetchQuotaForProvider('claude');

    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(claude.fetchQuota).not.toHaveBeenCalled();
  });

  it('reports a failed credential read as not configured, never as a configured failure', async () => {
    codex.isConfigured.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const result = await fetchQuotaForProvider('codex');

    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(codex.fetchQuota).not.toHaveBeenCalled();
  });

  it('reports a fetch that throws for a signed-in provider as a configured failure', async () => {
    claude.fetchQuota.mockRejectedValue(new Error('unexpected payload'));

    const result = await fetchQuotaForProvider('claude');

    expect(result.configured).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unexpected payload');
  });
});

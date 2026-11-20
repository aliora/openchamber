/**
 * Quota Providers Registry
 *
 * Implements quota fetching for the engines' own subscriptions using a registry pattern.
 * Each provider reads the sign-in its CLI keeps on this machine.
 * @module quota/providers
 */

import path from 'node:path';

import { buildResult } from '../utils/index.js';

import * as antigravity from './antigravity.js';
import * as claude from './claude/index.js';
import * as codex from './codex.js';

const registry = {
  claude: {
    providerId: claude.providerId,
    providerName: claude.providerName,
    isConfigured: claude.isConfigured,
    fetchQuota: claude.fetchQuota
  },
  codex: {
    providerId: codex.providerId,
    providerName: codex.providerName,
    isConfigured: codex.isConfigured,
    fetchQuota: codex.fetchQuota
  },
  antigravity: {
    providerId: antigravity.providerId,
    providerName: antigravity.providerName,
    isConfigured: antigravity.isConfigured,
    fetchQuota: antigravity.fetchQuota
  }
};

const pendingFetches = new Map();

/**
 * Whether the provider's CLI has a usable sign-in on this machine. A credential
 * read that throws counts as "nothing to read": the provider is hidden, not
 * shown as a failing one.
 */
const hasCredential = async (provider, options) => {
  try {
    return Boolean(await (options ? provider.isConfigured(options) : provider.isConfigured()));
  } catch {
    return false;
  }
};

export const listConfiguredQuotaProviders = async (optionsByProvider) => {
  const entries = Object.entries(registry);
  const configured = await Promise.all(entries.map(([id, provider]) => hasCredential(provider, optionsByProvider?.[id])));
  return entries.filter((_entry, index) => configured[index]).map(([id]) => id);
};

const scopeKeyFor = (providerId, options) => {
  if (!options) return providerId;
  const scope = options.accountId ?? (options.configDir ? path.resolve(options.configDir) : 'default');
  return `${providerId}:${scope}`;
};

const fetchQuotaForProviderUncoalesced = async (providerId, options) => {
  const provider = registry[providerId];

  if (!provider) {
    return buildResult({
      providerId,
      providerName: providerId,
      ok: false,
      configured: false,
      error: 'Unsupported provider'
    });
  }

  // Without a sign-in the provider is not set up. It never reaches `fetchQuota`,
  // so nothing it throws can turn that into a configured provider that failed.
  if (!(await hasCredential(provider, options))) {
    return buildResult({
      providerId: provider.providerId,
      providerName: provider.providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    return await (options ? provider.fetchQuota(options) : provider.fetchQuota());
  } catch (error) {
    return buildResult({
      providerId: provider.providerId,
      providerName: provider.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const fetchQuotaForProvider = (providerId, options) => {
  const pendingKey = scopeKeyFor(providerId, options);
  const existing = pendingFetches.get(pendingKey);
  if (existing) return existing;

  const pending = fetchQuotaForProviderUncoalesced(providerId, options).finally(() => {
    if (pendingFetches.get(pendingKey) === pending) pendingFetches.delete(pendingKey);
  });
  pendingFetches.set(pendingKey, pending);
  return pending;
};

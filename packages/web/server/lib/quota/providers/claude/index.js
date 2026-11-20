/**
 * Claude subscription quota.
 *
 * Reports the plan limits Claude Code itself is bound by (rolling session
 * window, weekly windows, model-scoped weekly windows, and paid extra usage)
 * using the OAuth credential Claude Code already holds.
 *
 * @module quota/providers/claude
 */

import { createHash } from 'crypto';
import path from 'path';

import { buildResult } from '../../utils/index.js';
import { findClaudeCredential } from './auth.js';
import { toClaudeUsage } from './transforms.js';

export const providerId = 'claude';
export const providerName = 'Claude';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const SESSION_EXPIRED_ERROR = 'Claude session expired. Open Claude Code to sign in again.';

/**
 * Last good payload per account scope, kept only to survive Anthropic's
 * aggressive rate limiting. Keyed by credential fingerprint so re-signing into
 * the same slot never serves the previous login's numbers.
 *
 * @type {Map<string, { cachedUsage: { fingerprint: string, usage: object, planLabel: string|null }|null, cooldownUntil: number, pendingFetch: Promise<object>|null, lastFingerprint: string|null }>}
 */
const statesByScope = new Map();

const scopeKeyFor = ({ accountId, configDir } = {}) =>
  accountId || (configDir ? path.resolve(configDir) : 'default');

const stateForScope = (scopeKey) => {
  let state = statesByScope.get(scopeKey);
  if (!state) {
    state = { cachedUsage: null, cooldownUntil: 0, pendingFetch: null, lastFingerprint: null };
    statesByScope.set(scopeKey, state);
  }
  return state;
};

const fingerprintOf = (credential) =>
  createHash('sha256').update(`${credential.accessToken}\0${credential.refreshToken ?? ''}`).digest('hex');

const cooldownFromHeader = (response) => {
  const raw = response.headers.get('retry-after');
  const retryAfter = Number(raw);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }
  const retryAt = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    return Math.min(retryAt - Date.now(), MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
};

const cachedResultFor = (state, fingerprint, planLabel) => {
  if (!state.cachedUsage || state.cachedUsage.fingerprint !== fingerprint) return null;
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: state.cachedUsage.usage,
    planLabel: planLabel ?? state.cachedUsage.planLabel
  });
};

const failure = (error, { configured = true } = {}) =>
  buildResult({ providerId, providerName, ok: false, configured, error });

export const isConfigured = async (options) => Boolean(await findClaudeCredential(options));

const fetchQuotaUncoalesced = async (options, state) => {
  const credential = await findClaudeCredential(options);
  if (!credential) {
    return failure('Not configured', { configured: false });
  }

  const fingerprint = fingerprintOf(credential);
  if (state.lastFingerprint !== null && state.lastFingerprint !== fingerprint) {
    state.cachedUsage = null;
    state.cooldownUntil = 0;
  }
  state.lastFingerprint = fingerprint;

  const expiresAt = credential.expiresAt;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  if (Date.now() < state.cooldownUntil) {
    return cachedResultFor(state, fingerprint, credential.planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  let response;
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER
      }
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }

  if (response.status === 429) {
    state.cooldownUntil = Date.now() + cooldownFromHeader(response);
    return cachedResultFor(state, fingerprint, credential.planLabel)
      ?? failure('Rate limited. Retrying soon.');
  }

  if (response.status === 401 || response.status === 403) {
    return failure(SESSION_EXPIRED_ERROR);
  }

  if (!response.ok) {
    return failure(`API error: ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return failure('Unexpected response from Anthropic');
  }

  const { windows, models } = toClaudeUsage(payload);
  const usage = Object.keys(models).length > 0 ? { windows, models } : { windows };
  state.cachedUsage = { fingerprint, usage, planLabel: credential.planLabel };

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
    planLabel: credential.planLabel
  });
};

export const fetchQuota = (options) => {
  const state = stateForScope(scopeKeyFor(options));
  if (state.pendingFetch) return state.pendingFetch;

  const request = fetchQuotaUncoalesced(options, state);
  const pending = request.finally(() => {
    if (state.pendingFetch === pending) state.pendingFetch = null;
  });
  state.pendingFetch = pending;
  return state.pendingFetch;
};

/** Test seam: clears the rate-limit cache between cases. */
export const resetClaudeQuotaCache = () => {
  statesByScope.clear();
};

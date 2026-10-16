import os from 'node:os';
import path from 'node:path';

import {
  asObject,
  asNonEmptyString,
  buildResult,
  readJsonFile,
  resolveWindowLabel,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'Codex';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const codexHomeDirectory = () => {
  const override = asNonEmptyString(process.env.CODEX_HOME);
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
};

/**
 * The ChatGPT sign-in Codex CLI keeps in `${CODEX_HOME:-~/.codex}/auth.json`
 * (`tokens.access_token` and `tokens.account_id`).
 *
 * Read-only and read fresh per request: Codex rotates the refresh token on every
 * exchange, so refreshing here would sign the user out of Codex. A login with
 * an API key only has no `tokens` and no usage endpoint, so it reads as not
 * configured, as does a missing or unreadable file, or a login Codex keeps in
 * the OS keyring instead of the file.
 *
 * @returns {{ accessToken: string, accountId: string|null }|null}
 */
export const readCodexCredential = () => {
  const tokens = asObject(asObject(readJsonFile(path.join(codexHomeDirectory(), 'auth.json')))?.tokens);
  const accessToken = asNonEmptyString(tokens?.access_token);
  if (!accessToken) return null;
  return { accessToken, accountId: asNonEmptyString(tokens.account_id) };
};

export const isConfigured = () => Boolean(readCodexCredential());

export const fetchQuota = async () => {
  const credential = readCodexCredential();

  if (!credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json'
    };
    if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Codex session expired. Open Codex to sign in again.'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at)
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at)
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? String(balance)
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label
      });
    }

    // Business/enterprise accounts expose a dollar spend cap under
    // `spend_control.individual_limit`. Surface it as an additive `credits`
    // window so existing consumers keep working.
    if (payload?.spend_control?.individual_limit) {
      const spendLimit = payload.spend_control.individual_limit;
      const used = toNumber(spendLimit.used);
      const limit = toNumber(spendLimit.limit);
      const valueLabel = used !== null && limit !== null
        ? `${used.toFixed(0)} / ${limit.toFixed(0)} used`
        : null;
      windows.credits = toUsageWindow({
        usedPercent: toNumber(spendLimit.used_percent),
        windowSeconds: null,
        resetAt: null,
        valueLabel
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

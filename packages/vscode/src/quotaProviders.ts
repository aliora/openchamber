import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

// Usage for the engines' own subscriptions. Each provider reads the login its
// CLI keeps on this machine, read-only: the CLI owns the OAuth refresh token
// and a refresh from here would sign the user out of it. This duplicates
// `packages/web/server/lib/quota/`; keep the two in sync.

const execFileAsync = promisify(execFile);

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
};

type ProviderUsage = {
  windows: Record<string, UsageWindow>;
  models?: Record<string, ProviderUsage>;
};

type OpenAiUsagePayload = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
    secondary_window?: {
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    };
  };
  credits?: {
    balance?: number | string;
    unlimited?: boolean;
  };
  spend_control?: {
    individual_limit?: {
      limit?: number | string;
      used?: number | string;
      used_percent?: number | string;
    };
  };
};

type ProviderResult = {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: ProviderUsage | null;
  fetchedAt: number;
  error?: string;
  planLabel?: string | null;
};

const asObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toTimestamp = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const formatResetTime = (timestamp: number) => {
  try {
    const resetDate = new Date(timestamp);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      // Same day: show time only (e.g., "9:56 PM")
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    // Different day: show date + weekday + time (e.g., "Feb 2, Sun 9:56 PM")
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

const calculateResetAfterSeconds = (resetAt: number | null) => {
  if (!resetAt) return null;
  const delta = Math.floor((resetAt - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

const toUsageWindow = (data: { usedPercent: number | null; windowSeconds: number | null; resetAt: number | null; valueLabel?: string | null }) => {
  const resetAfterSeconds = calculateResetAfterSeconds(data.resetAt);
  const resetFormatted = data.resetAt ? formatResetTime(data.resetAt) : null;
  return {
    usedPercent: data.usedPercent,
    remainingPercent: data.usedPercent !== null ? Math.max(0, 100 - data.usedPercent) : null,
    windowSeconds: data.windowSeconds ?? null,
    resetAfterSeconds,
    resetAt: data.resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(data.valueLabel ? { valueLabel: data.valueLabel } : {}),
  } satisfies UsageWindow;
};

const buildResult = (data: {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: ProviderUsage | null;
  error?: string;
  planLabel?: string | null;
}): ProviderResult => {
  const result: ProviderResult = {
    providerId: data.providerId,
    providerName: data.providerName,
    ok: data.ok,
    configured: data.configured,
    usage: data.usage ?? null,
    ...(data.error ? { error: data.error } : {}),
    fetchedAt: Date.now(),
  };
  if (data.planLabel) result.planLabel = data.planLabel;
  return result;
};

const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

const resolveWindowLabel = (windowSeconds: number | null) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const nonBlank = z.string().trim().min(1);

/**
 * `schema`-shaped contents of a JSON document, or null when the text is not
 * JSON or does not fit. A blank text or a document that does not fit is an
 * ordinary state (a blob holding only other apps' tokens). Only invalid JSON
 * is reported, and never with its text, since these documents hold
 * credentials and a syntax error quotes what it choked on.
 */
const parseJson = <T extends z.ZodType>(text: string, schema: T, label: string): z.output<T> | null => {
  if (!text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`Quota: ${label} is not valid JSON`);
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
};

const readJsonFile = <T extends z.ZodType>(filePath: string, schema: T): z.output<T> | null => {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Missing or unreadable: the CLI has no login for us to read.
    return null;
  }
  return parseJson(text, schema, filePath);
};

type ClaudeCredential = {
  accessToken: string;
  refreshToken: string | null;
  planLabel: string | null;
};

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Claude Code writes one JSON blob holding both its own OAuth tokens
 * (`claudeAiOauth`) and unrelated MCP server tokens. Only the former is read.
 */
const claudeCodeBlobSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: nonBlank,
    refreshToken: nonBlank.nullish().catch(null),
    subscriptionType: nonBlank.nullish().catch(null),
  }),
});

const claudeCredentialFrom = (blob: z.output<typeof claudeCodeBlobSchema> | null): ClaudeCredential | null => (
  blob
    ? {
        accessToken: blob.claudeAiOauth.accessToken,
        refreshToken: blob.claudeAiOauth.refreshToken ?? null,
        planLabel: blob.claudeAiOauth.subscriptionType ?? null,
      }
    : null
);

const claudeConfigDirectory = () => {
  const override = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
};

const readClaudeKeychain = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    // No entry, or the user denied Keychain access. Both mean "try the next source".
    return null;
  }
};

type ClaudeCredentialDependencies = {
  platform?: NodeJS.Platform;
  readKeychain?: () => Promise<string | null>;
};

/**
 * The login Claude Code keeps: the macOS Keychain entry first (the credentials
 * file there is a leftover Claude Code no longer updates), then
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`, then Claude Code's own
 * `CLAUDE_CODE_OAUTH_TOKEN` override. Read fresh per request.
 */
export const readClaudeCredential = async ({
  platform = process.platform,
  readKeychain = readClaudeKeychain,
}: ClaudeCredentialDependencies = {}): Promise<ClaudeCredential | null> => {
  if (platform === 'darwin') {
    const raw = await readKeychain();
    const fromKeychain = raw ? claudeCredentialFrom(parseJson(raw, claudeCodeBlobSchema, 'the Claude Keychain entry')) : null;
    if (fromKeychain) return fromKeychain;
  }
  const fromFile = claudeCredentialFrom(readJsonFile(path.join(claudeConfigDirectory(), '.credentials.json'), claudeCodeBlobSchema));
  if (fromFile) return fromFile;
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  return accessToken ? { accessToken, refreshToken: null, planLabel: null } : null;
};

type CodexCredential = {
  accessToken: string;
  accountId: string | null;
};

/** What Codex CLI keeps in `auth.json`. A login with an API key only has no `tokens`. */
const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: nonBlank,
    account_id: nonBlank.nullish().catch(null),
  }),
});

const codexHomeDirectory = () => {
  const override = asNonEmptyString(process.env.CODEX_HOME);
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
};

const readCodexCredential = (): CodexCredential | null => {
  const auth = readJsonFile(path.join(codexHomeDirectory(), 'auth.json'), codexAuthSchema);
  return auth ? { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id ?? null } : null;
};

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const fetchCodexQuota = async (): Promise<ProviderResult> => {
  const credential = readCodexCredential();

  if (!credential) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
    };
    if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'codex',
        providerName: 'Codex',
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Codex session expired. Open Codex to sign in again.'
          : `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as OpenAiUsagePayload;
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows: Record<string, UsageWindow> = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at),
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at),
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const valueLabel = unlimited
        ? 'Unlimited'
        : balance !== null
          ? String(balance)
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel,
      });
    }
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
        valueLabel,
      });
    }

    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'codex',
      providerName: 'Codex',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const CLAUDE_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const CLAUDE_MAX_COOLDOWN_MS = 60 * 60 * 1000;
let claudeCredentialFingerprint: string | null = null;
let claudeCachedUsage: ProviderUsage | null = null;
let claudeCooldownUntil = 0;

const claudeCooldownFromResponse = (response: Response): number => {
  const raw = response.headers.get('retry-after');
  const seconds = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, CLAUDE_MAX_COOLDOWN_MS);
  }
  if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return Math.min(retryAt - Date.now(), CLAUDE_MAX_COOLDOWN_MS);
    }
  }
  return CLAUDE_DEFAULT_COOLDOWN_MS;
};

const buildClaudeRateLimitResult = (planLabel: string | null): ProviderResult => (
  claudeCachedUsage
    ? buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: true,
        configured: true,
        usage: claudeCachedUsage,
        planLabel,
      })
    : buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Rate limited. Retrying soon.',
      })
);

const buildClaudeUsage = (payload: Record<string, unknown>): ProviderUsage => {
  const windows: Record<string, UsageWindow> = {};
  const models: Record<string, ProviderUsage> = {};
  const limits = Array.isArray(payload.limits) ? payload.limits : [];

  for (const entry of limits) {
    const limit = asObject(entry);
    if (!limit) continue;
    const usedPercent = toNumber(limit.percent);
    const resetAt = toTimestamp(limit.resets_at);
    if (limit.kind === 'session') {
      windows['5h'] = toUsageWindow({ usedPercent, windowSeconds: 5 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_all') {
      windows['7d'] = toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_scoped') {
      const modelName = asNonEmptyString(asObject(asObject(limit.scope)?.model)?.display_name);
      if (modelName) {
        models[modelName] = {
          windows: {
            '7d': toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt }),
          },
        };
      }
    }
  }

  if (!limits.length) {
    const fiveHour = asObject(payload.five_hour);
    const sevenDay = asObject(payload.seven_day);
    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: 5 * 60 * 60,
        resetAt: toTimestamp(fiveHour.resets_at),
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: toTimestamp(sevenDay.resets_at),
      });
    }
  }

  const spend = asObject(payload.spend);
  if (spend?.enabled === true) {
    const usedMoney = asObject(spend.used);
    const limitMoney = asObject(spend.limit);
    const usedMinor = toNumber(usedMoney?.amount_minor);
    const limitMinor = toNumber(limitMoney?.amount_minor);
    const exponent = toNumber(usedMoney?.exponent) ?? 2;
    const currency = asNonEmptyString(usedMoney?.currency);
    const prefix = currency === 'USD' || !currency ? '$' : `${currency} `;
    const used = usedMinor === null ? null : usedMinor / 10 ** exponent;
    const limit = limitMinor === null ? null : limitMinor / 10 ** (toNumber(limitMoney?.exponent) ?? 2);
    windows.extra_usage = toUsageWindow({
      usedPercent: toNumber(spend.percent),
      windowSeconds: null,
      resetAt: null,
      valueLabel: used === null ? null : `${prefix}${formatMoney(used)}${limit === null ? '' : ` / ${prefix}${formatMoney(limit)}`}`,
    });
  }

  return Object.keys(models).length ? { windows, models } : { windows };
};

const fetchClaudeQuota = async (): Promise<ProviderResult> => {
  const credential = await readClaudeCredential();

  if (!credential) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const fingerprint = `${credential.accessToken}\0${credential.refreshToken ?? ''}`;
  if (claudeCredentialFingerprint !== fingerprint) {
    claudeCredentialFingerprint = fingerprint;
    claudeCachedUsage = null;
    claudeCooldownUntil = 0;
  }
  if (Date.now() < claudeCooldownUntil) return buildClaudeRateLimitResult(credential.planLabel);

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (response.status === 429) {
      claudeCooldownUntil = Date.now() + claudeCooldownFromResponse(response);
      return buildClaudeRateLimitResult(credential.planLabel);
    }

    if (response.status === 401 || response.status === 403) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Claude session expired. Open Claude Code to sign in again.',
      });
    }

    if (!response.ok) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const usage = buildClaudeUsage(payload);
    claudeCachedUsage = usage;
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage,
      planLabel: credential.planLabel,
    });
  } catch (error) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type QuotaProvider = {
  providerName: string;
  isConfigured: () => Promise<boolean>;
  fetchQuota: () => Promise<ProviderResult>;
};

const quotaProviders = new Map<string, QuotaProvider>([
  ['claude', {
    providerName: 'Claude',
    isConfigured: async () => (await readClaudeCredential()) !== null,
    fetchQuota: fetchClaudeQuota,
  }],
  ['codex', {
    providerName: 'Codex',
    isConfigured: async () => readCodexCredential() !== null,
    fetchQuota: fetchCodexQuota,
  }],
]);

/**
 * Whether the provider's CLI has a usable login on this machine. A credential
 * read that throws counts as "nothing to read": the provider is hidden, not
 * shown as a failing one.
 */
const hasCredential = async (provider: QuotaProvider): Promise<boolean> => {
  try {
    return await provider.isConfigured();
  } catch {
    return false;
  }
};

/** Providers whose CLI is signed in. */
export const listConfiguredQuotaProviders = async (): Promise<string[]> => {
  const entries = Array.from(quotaProviders.entries());
  const configured = await Promise.all(entries.map(([, provider]) => hasCredential(provider)));
  return entries.filter((_entry, index) => configured[index]).map(([providerId]) => providerId);
};

const fetchQuotaForProviderUncoalesced = async (providerId: string): Promise<ProviderResult> => {
  const provider = quotaProviders.get(providerId);
  if (!provider) {
    return buildResult({
      providerId,
      providerName: providerId,
      ok: false,
      configured: false,
      error: 'Unsupported provider',
    });
  }

  // Without a login the provider is not set up. It never reaches `fetchQuota`,
  // so nothing it throws can turn that into a configured provider that failed.
  if (!(await hasCredential(provider))) {
    return buildResult({
      providerId,
      providerName: provider.providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    return await provider.fetchQuota();
  } catch (error) {
    return buildResult({
      providerId,
      providerName: provider.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const pendingQuotaFetches = new Map<string, Promise<ProviderResult>>();

export const fetchQuotaForProvider = (providerId: string): Promise<ProviderResult> => {
  const existing = pendingQuotaFetches.get(providerId);
  if (existing) return existing;

  const pending = fetchQuotaForProviderUncoalesced(providerId).finally(() => {
    if (pendingQuotaFetches.get(providerId) === pending) pendingQuotaFetches.delete(providerId);
  });
  pendingQuotaFetches.set(providerId, pending);
  return pending;
};

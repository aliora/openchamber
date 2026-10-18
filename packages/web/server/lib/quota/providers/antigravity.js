import { getAgyAuthStatus } from '../../engine/antigravity/adapter.js';
import { runAgy } from '../../engine/antigravity/platform.js';
import { asObject, buildResult, toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

export const providerId = 'antigravity';
export const providerName = 'Antigravity';

const CACHE_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const WINDOW_SECONDS = { weekly: 7 * 24 * 3600, '5h': 5 * 3600 };

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readCommandData = async (run, command) => {
  const { exitCode, stdout, error } = await run(['-p', `/${command}`, '--output-format', 'json'], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (error || exitCode !== 0) return null;
  const output = asObject(parseJson(stdout));
  return output?.command?.name === command ? asObject(output.command.data) : null;
};

const toBucketWindow = (bucket) => {
  const remaining = toNumber(bucket?.remaining_fraction);
  if (remaining === null) return null;
  return toUsageWindow({
    usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
    windowSeconds: WINDOW_SECONDS[bucket.window] ?? null,
    resetAt: toTimestamp(bucket.reset_time),
  });
};

const toWindows = (usage, credits) => {
  const windows = {};
  for (const group of usage.groups) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const window = toBucketWindow(bucket);
      if (window) windows[`${group.name} · ${bucket.window}`] = window;
    }
  }
  const balance = toNumber(credits?.remaining_credits);
  if (balance !== null) {
    windows.credits_balance = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: String(balance) });
  }
  return windows;
};

const failure = (configured, error) => buildResult({ providerId, providerName, ok: false, configured, error });

export const createAntigravityQuota = ({ run = runAgy, authStatus = getAgyAuthStatus, now = Date.now } = {}) => {
  let auth = null;
  let cached = null;

  const isConfigured = async () => {
    if (!auth || now() - auth.at >= CACHE_MS) {
      const status = await authStatus({ run });
      auth = { at: now(), loggedIn: Boolean(status?.loggedIn) };
    }
    return auth.loggedIn;
  };

  const fetchQuota = async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    if (!(await isConfigured())) return failure(false, 'Not configured');

    const [usage, credits] = await Promise.all([readCommandData(run, 'usage'), readCommandData(run, 'credits')]);
    if (!Array.isArray(usage?.groups)) return failure(true, 'agy did not report its usage. Run /usage in agy to check the account.');

    const result = buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: toWindows(usage, credits) } });
    cached = { at: now(), result };
    return result;
  };

  return { isConfigured, fetchQuota };
};

const quota = createAntigravityQuota();

export const isConfigured = quota.isConfigured;
export const fetchQuota = quota.fetchQuota;

// Recognizes a turn that stopped on a usage limit and works out when the
// limit lifts: first from the CLI's own error text, then from the engine's
// quota windows (`../quota/providers`).

const LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[ _-]?limit/i,
  /usage[ _-]?limit/i,
  /\bquota\b/i,
  /hit your (?:usage )?limit/i,
  /resets? (?:at|in)\b/i,
  /try again (?:at|in)\b/i,
  /\bexhausted\b/i,
  /\boverloaded\b/i,
  /too many requests/i,
];

/** Whether an error message reads as a usage, rate or quota limit. */
export const isQuotaLimitError = (message) => {
  if (!message) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(message));
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const toEpochMs = (digits) => {
  const value = Number(digits);
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

// "Claude AI usage limit reached|1763481600"
const parseEpoch = (text) => {
  const match = text.match(/\|(\d{10}|\d{13})\b/);
  return match ? toEpochMs(match[1]) : null;
};

const parseIsoDate = (text) => {
  const match = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (!match) return null;
  const parsed = Date.parse(match[0]);
  return Number.isNaN(parsed) ? null : parsed;
};

const DURATION_UNITS = [
  [/(\d+(?:\.\d+)?)\s*(?:days?|d)\b/i, DAY_MS],
  [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, HOUR_MS],
  [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, MINUTE_MS],
  [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, 1000],
];

// "try again in 2 hours 5 minutes", "resets in 45m"
const parseRelative = (text, now) => {
  const match = text.match(/\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?){1,4})/i);
  if (!match) return null;
  let total = 0;
  for (const [pattern, unit] of DURATION_UNITS) {
    const part = match[1].match(pattern);
    if (part) total += Number(part[1]) * unit;
  }
  return total > 0 ? now + Math.round(total) : null;
};

// "resets 3pm", "resets at 3:30 PM", "try again at 15:45"
const parseClockTime = (text, now) => {
  const match = text.match(/(?:resets?|try again|available)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (!match[2] && !meridiem) return null;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setTime(at.getTime() + DAY_MS);
  return at.getTime();
};

/** The time the error text says the limit lifts, in ms, or null when it names none in the future. */
export const parseResetFromText = (message, now = Date.now()) => {
  if (!message) return null;
  const candidates = [parseEpoch(message), parseIsoDate(message), parseRelative(message, now), parseClockTime(message, now)];
  return candidates.find((value) => value !== null && value > now) ?? null;
};

const EXHAUSTED_PERCENT = 99;

const collectWindows = (usage) => {
  const windows = Object.entries(usage?.windows ?? {}).map(([label, window]) => ({ label, window }));
  for (const [model, entry] of Object.entries(usage?.models ?? {})) {
    for (const [label, window] of Object.entries(entry?.windows ?? {})) {
      windows.push({ label: `${model} ${label}`, window });
    }
  }
  return windows;
};

/**
 * The reset that ends the limit, from a quota provider result: the latest
 * reset among exhausted windows (every one of them has to lift), else the
 * nearest future reset. Null when the result names no future reset.
 */
export const pickQuotaReset = (quota, now = Date.now()) => {
  if (!quota?.ok) return null;
  const future = collectWindows(quota.usage).filter(({ window }) => Number.isFinite(window?.resetAt) && window.resetAt > now);
  if (future.length === 0) return null;
  const exhausted = future.filter(({ window }) => Number.isFinite(window.usedPercent) && window.usedPercent >= EXHAUSTED_PERCENT);
  const pick = exhausted.length > 0
    ? exhausted.reduce((latest, entry) => (entry.window.resetAt > latest.window.resetAt ? entry : latest))
    : future.reduce((nearest, entry) => (entry.window.resetAt < nearest.window.resetAt ? entry : nearest));
  return { resetAt: pick.window.resetAt, window: pick.label };
};

export const FALLBACK_RESUME_DELAY_MS = 30 * MINUTE_MS;

/**
 * When to resume after a limit: the error text first, then the engine's quota
 * windows, else 30 minutes from now. `fetchQuota(engineId)` may reject; the
 * fallback covers it.
 */
export const resolveLimitReset = async ({ message, engineId, fetchQuota, now = Date.now() }) => {
  const fromText = parseResetFromText(message, now);
  if (fromText) return { resetAt: fromText, window: 'error' };
  if (fetchQuota && engineId) {
    try {
      const fromQuota = pickQuotaReset(await fetchQuota(engineId), now);
      if (fromQuota) return fromQuota;
    } catch {
      // The quota read is a hint; the fallback below still schedules a resume.
    }
  }
  return { resetAt: now + FALLBACK_RESUME_DELAY_MS, window: null };
};

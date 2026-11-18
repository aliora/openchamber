import { describe, it, expect } from 'bun:test';
import {
  FALLBACK_RESUME_DELAY_MS,
  isQuotaLimitError,
  parseResetFromText,
  pickQuotaReset,
  resolveLimitReset,
} from './quota-limit.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const localTime = (hours, minutes, dayOffset = 0) => new Date(2026, 10, 18 + dayOffset, hours, minutes, 0, 0).getTime();

describe('isQuotaLimitError', () => {
  it.each([
    'Request failed with status 429',
    'Rate limit exceeded',
    'rate_limit_error',
    'Claude AI usage limit reached',
    'Quota exceeded for this project',
    "You've hit your limit",
    "You've hit your usage limit",
    'Limit resets at 3pm',
    'Please try again in 2 hours',
    'Capacity exhausted',
    'The server is overloaded',
    'Too many requests',
  ])('recognizes %j', (message) => {
    expect(isQuotaLimitError(message)).toBe(true);
  });

  it.each(['file not found', '', null, undefined, 42, {}])('rejects %j', (message) => {
    expect(isQuotaLimitError(message)).toBe(false);
  });
});

describe('parseResetFromText', () => {
  it('reads epoch seconds after a pipe', () => {
    const epochSeconds = Math.floor((NOW + 2 * HOUR) / 1000);
    expect(parseResetFromText(`Claude AI usage limit reached|${epochSeconds}`, NOW)).toBe(epochSeconds * 1000);
  });

  it('reads epoch milliseconds after a pipe', () => {
    expect(parseResetFromText(`limit reached|${NOW + HOUR}`, NOW)).toBe(NOW + HOUR);
  });

  it('reads an ISO date', () => {
    const iso = new Date(NOW + 3 * HOUR).toISOString();
    expect(parseResetFromText(`Quota resets at ${iso}`, NOW)).toBe(NOW + 3 * HOUR);
  });

  it('reads a relative duration of hours and minutes', () => {
    expect(parseResetFromText('Please try again in 2 hours 5 minutes', NOW)).toBe(NOW + 2 * HOUR + 5 * MINUTE);
  });

  it('reads a short relative duration', () => {
    expect(parseResetFromText('Your limit resets in 45m', NOW)).toBe(NOW + 45 * MINUTE);
  });

  it('reads a clock time with a meridiem and ignores the zone label', () => {
    expect(parseResetFromText('Your limit resets 3pm (Europe/Istanbul)', NOW)).toBe(localTime(15, 0));
  });

  it('reads a 24-hour clock time', () => {
    expect(parseResetFromText('try again at 15:45', NOW)).toBe(localTime(15, 45));
  });

  it('rolls a clock time already past to the next day', () => {
    expect(parseResetFromText('try again at 15:45', localTime(16, 0))).toBe(localTime(15, 45, 1));
  });

  it('returns null for a time in the past', () => {
    expect(parseResetFromText(`limit reached|${Math.floor((NOW - HOUR) / 1000)}`, NOW)).toBeNull();
    expect(parseResetFromText(`resets at ${new Date(NOW - HOUR).toISOString()}`, NOW)).toBeNull();
  });

  it('returns null for a bare hour without minutes or meridiem', () => {
    expect(parseResetFromText('limit resets at 3', NOW)).toBeNull();
  });

  it('returns null for text without a time and for non-strings', () => {
    expect(parseResetFromText('rate limit exceeded', NOW)).toBeNull();
    expect(parseResetFromText('', NOW)).toBeNull();
    expect(parseResetFromText(undefined, NOW)).toBeNull();
  });
});

describe('pickQuotaReset', () => {
  const quota = (usage) => ({ ok: true, usage });

  it('picks the latest reset among exhausted windows', () => {
    const result = pickQuotaReset(quota({
      windows: {
        five_hour: { usedPercent: 100, resetAt: NOW + HOUR },
        weekly: { usedPercent: 99.5, resetAt: NOW + 5 * HOUR },
        daily: { usedPercent: 10, resetAt: NOW + 10 * HOUR },
      },
    }), NOW);
    expect(result).toEqual({ resetAt: NOW + 5 * HOUR, window: 'weekly' });
  });

  it('picks the nearest future reset when nothing is exhausted', () => {
    const result = pickQuotaReset(quota({
      windows: {
        weekly: { usedPercent: 40, resetAt: NOW + 5 * HOUR },
        five_hour: { usedPercent: 20, resetAt: NOW + HOUR },
      },
    }), NOW);
    expect(result).toEqual({ resetAt: NOW + HOUR, window: 'five_hour' });
  });

  it('includes per-model windows with the model in the label', () => {
    const result = pickQuotaReset(quota({
      windows: { five_hour: { usedPercent: 10, resetAt: NOW + 4 * HOUR } },
      models: { opus: { windows: { weekly: { usedPercent: 100, resetAt: NOW + 2 * HOUR } } } },
    }), NOW);
    expect(result).toEqual({ resetAt: NOW + 2 * HOUR, window: 'opus weekly' });
  });

  it('ignores resets in the past', () => {
    const result = pickQuotaReset(quota({
      windows: {
        old: { usedPercent: 100, resetAt: NOW - HOUR },
        next: { usedPercent: 50, resetAt: NOW + HOUR },
      },
    }), NOW);
    expect(result).toEqual({ resetAt: NOW + HOUR, window: 'next' });
  });

  it('returns null when no window resets in the future', () => {
    expect(pickQuotaReset(quota({ windows: { old: { usedPercent: 100, resetAt: NOW - HOUR } } }), NOW)).toBeNull();
    expect(pickQuotaReset(quota({}), NOW)).toBeNull();
  });

  it('returns null for a failed or missing quota', () => {
    expect(pickQuotaReset({ ok: false, usage: { windows: { a: { usedPercent: 100, resetAt: NOW + HOUR } } } }, NOW)).toBeNull();
    expect(pickQuotaReset(null, NOW)).toBeNull();
  });
});

describe('resolveLimitReset', () => {
  const quotaResult = { ok: true, usage: { windows: { five_hour: { usedPercent: 100, resetAt: NOW + 4 * HOUR } } } };

  it('prefers the error text over the quota', async () => {
    const fetchQuota = async () => quotaResult;
    const result = await resolveLimitReset({ message: 'try again in 1 hour', engineId: 'claude', fetchQuota, now: NOW });
    expect(result).toEqual({ resetAt: NOW + HOUR, window: 'error' });
  });

  it('uses the quota when the text names no time', async () => {
    const fetchQuota = async (engineId) => (engineId === 'claude' ? quotaResult : null);
    const result = await resolveLimitReset({ message: 'rate limit exceeded', engineId: 'claude', fetchQuota, now: NOW });
    expect(result).toEqual({ resetAt: NOW + 4 * HOUR, window: 'five_hour' });
  });

  it('falls back to 30 minutes when the quota read rejects', async () => {
    const fetchQuota = async () => {
      throw new Error('offline');
    };
    const result = await resolveLimitReset({ message: 'rate limit exceeded', engineId: 'claude', fetchQuota, now: NOW });
    expect(result).toEqual({ resetAt: NOW + FALLBACK_RESUME_DELAY_MS, window: null });
  });

  it('falls back without an engine or a quota reader', async () => {
    const fetchQuota = async () => quotaResult;
    expect(await resolveLimitReset({ message: 'rate limit', fetchQuota, now: NOW })).toEqual({ resetAt: NOW + 30 * MINUTE, window: null });
    expect(await resolveLimitReset({ message: 'rate limit', engineId: 'claude', now: NOW })).toEqual({ resetAt: NOW + 30 * MINUTE, window: null });
  });
});

import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, formatWindowLabel } from './utils';

describe('quota utils', () => {
  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });

  test('labels the windows Claude and Codex report', () => {
    expect(formatWindowLabel('5h')).toBe('5-Hour');
    expect(formatWindowLabel('7d')).toBe('7-Day Limit');
    expect(formatWindowLabel('weekly')).toBe('Weekly');
    expect(formatWindowLabel('extra_usage')).toBe('Extra Usage');
    expect(formatWindowLabel('credits_balance')).toBe('Credits Balance');
    expect(formatWindowLabel('credits')).toBe('Credits');
  });

  test('labels the window of an Antigravity model group after the group name', () => {
    expect(formatWindowLabel('Gemini Models · weekly')).toBe('Gemini Models · Weekly');
    expect(formatWindowLabel('Claude and GPT models · 5h')).toBe('Claude and GPT models · 5-Hour');
  });

  test('keeps the raw label of a window it has no name for', () => {
    expect(formatWindowLabel('30d')).toBe('30d');
  });

  test('labels the OpenRouter key cap apart from credit balances', () => {
    expect(formatWindowLabel('key_limit')).toBe('Key Limit');
    expect(formatWindowLabel('credits')).toBe('Credits');
  });
});

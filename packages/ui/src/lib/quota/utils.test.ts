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

  test('keeps the raw label of a window it has no name for', () => {
    expect(formatWindowLabel('30d')).toBe('30d');
  });
});

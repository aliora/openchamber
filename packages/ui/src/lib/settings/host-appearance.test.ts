import { describe, expect, test } from 'bun:test';

import {
  mergeHostAppearance,
  mergePinnedOrder,
  nextHostAppearanceStamp,
  type HostAppearance,
} from './host-appearance';

const NOW = 1_800_000_000_000;
const appearance = (parts: Partial<HostAppearance> = {}): HostAppearance => ({
  hostLabels: {},
  hostLogos: {},
  hostAppearanceStamps: {},
  ...parts,
});

describe('mergeHostAppearance', () => {
  test('a device returning with an old copy only changes the key it edited', () => {
    const server = appearance({
      hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI', 'server:pi': 'Pi5 Ana' },
      hostAppearanceStamps: {
        'labels:server:mac': { at: 100 },
        'labels:server:msi': { at: 100 },
        'labels:server:pi': { at: 500 },
      },
    });
    const returning = appearance({
      hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi' },
      hostAppearanceStamps: {
        'labels:server:mac': { at: 100 },
        'labels:server:msi': { at: 700 },
        'labels:server:pi': { at: 100 },
      },
    });

    const merged = mergeHostAppearance(server, returning, NOW);

    expect(merged.hostLabels).toEqual({ 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi5 Ana' });
  });

  test('a removal wins over an older value and survives a stale copy that still holds the value', () => {
    const removed = appearance({ hostAppearanceStamps: { 'labels:server:a': { at: NOW - 300, removed: true } } });
    const stale = appearance({ hostLabels: { 'server:a': 'Old' }, hostAppearanceStamps: { 'labels:server:a': { at: NOW - 400 } } });

    expect(mergeHostAppearance(removed, stale, NOW).hostLabels).toEqual({});
    expect(mergeHostAppearance(stale, removed, NOW).hostAppearanceStamps['labels:server:a']).toEqual({ at: NOW - 300, removed: true });
  });

  test('on equal stamps a value beats a removal and the larger value wins, in either order', () => {
    const one = appearance({ hostLabels: { 'server:a': 'Alpha' }, hostAppearanceStamps: { 'labels:server:a': { at: 5 } } });
    const two = appearance({ hostLabels: { 'server:a': 'Beta' }, hostAppearanceStamps: { 'labels:server:a': { at: 5 } } });
    const gone = appearance({ hostAppearanceStamps: { 'labels:server:a': { at: 5, removed: true } } });

    expect(mergeHostAppearance(one, two, NOW)).toEqual(mergeHostAppearance(two, one, NOW));
    expect(mergeHostAppearance(one, two, NOW).hostLabels['server:a']).toBe('Beta');
    expect(mergeHostAppearance(gone, one, NOW).hostLabels['server:a']).toBe('Alpha');
  });

  test('an unstamped entry counts as stamp 0: it fills a gap and loses to any stamped value', () => {
    const unstamped = appearance({ hostLabels: { 'server:a': 'Legacy', 'server:b': 'OnlyHere' } });
    const stamped = appearance({ hostLabels: { 'server:a': 'Current' }, hostAppearanceStamps: { 'labels:server:a': { at: 9 } } });

    expect(mergeHostAppearance(unstamped, stamped, NOW).hostLabels).toEqual({ 'server:a': 'Current', 'server:b': 'OnlyHere' });
  });

  test('a stamp from a clock far ahead is clamped to five minutes past now', () => {
    const fast = appearance({ hostLabels: { 'server:a': 'Fast' }, hostAppearanceStamps: { 'labels:server:a': { at: NOW + 10 * 86_400_000 } } });

    expect(mergeHostAppearance(fast, appearance(), NOW).hostAppearanceStamps['labels:server:a']?.at).toBe(NOW + 5 * 60_000);
  });

  test('tombstones older than 180 days are dropped', () => {
    const old = appearance({ hostAppearanceStamps: { 'labels:server:a': { at: NOW - 181 * 86_400_000, removed: true } } });

    expect(mergeHostAppearance(old, appearance(), NOW).hostAppearanceStamps).toEqual({});
  });

  test('logos merge per key the same way', () => {
    const left = appearance({ hostLogos: { 'server:a': 'dot:blue' }, hostAppearanceStamps: { 'logos:server:a': { at: 50 } } });
    const right = appearance({ hostLogos: { 'server:a': 'dot:green', 'server:b': 'dot:pink' }, hostAppearanceStamps: { 'logos:server:a': { at: 10 } } });

    expect(mergeHostAppearance(left, right, NOW).hostLogos).toEqual({ 'server:a': 'dot:blue', 'server:b': 'dot:pink' });
  });
});

describe('nextHostAppearanceStamp', () => {
  test('an edit always outranks what the device has already seen, even when its clock is behind', () => {
    const seen = { 'labels:server:a': { at: NOW + 60_000 } };

    expect(nextHostAppearanceStamp(seen, 'labels', 'server:a', false, NOW)['labels:server:a']).toEqual({ at: NOW + 60_001 });
    expect(nextHostAppearanceStamp({}, 'labels', 'server:a', true, NOW)['labels:server:a']).toEqual({ at: NOW, removed: true });
  });
});

describe('mergePinnedOrder', () => {
  test('keeps the newer order, appends keys only the older list had, and caps the length', () => {
    expect(mergePinnedOrder(['b', 'a'], ['a', 'c', 'b'])).toEqual(['b', 'a', 'c']);
    expect(mergePinnedOrder(Array.from({ length: 600 }, (_, index) => `k${index}`), [])).toHaveLength(256);
  });
});

import { describe, expect, it } from 'vitest';
import { mergeHostAppearance, mergePinnedOrder } from './host-appearance.js';

const NOW = 1_800_000_000_000;
const side = (parts = {}) => ({ hostLabels: {}, hostLogos: {}, hostAppearanceStamps: {}, ...parts });

describe('host appearance merge', () => {
  it('a copy returning with old values only changes the key it edited', () => {
    const server = side({
      hostLabels: { mac: 'Mac', pi: 'Pi5 Ana' },
      hostAppearanceStamps: { 'labels:mac': { at: 100 }, 'labels:pi': { at: 500 } },
    });
    const returning = side({
      hostLabels: { mac: 'Mac Studio', pi: 'Pi' },
      hostAppearanceStamps: { 'labels:mac': { at: 700 }, 'labels:pi': { at: 100 } },
    });

    expect(mergeHostAppearance(server, returning, NOW).hostLabels).toEqual({ mac: 'Mac Studio', pi: 'Pi5 Ana' });
  });

  it('a removal beats an older value; equal stamps resolve the same way in either order', () => {
    const removed = side({ hostAppearanceStamps: { 'labels:a': { at: NOW - 10, removed: true } } });
    const stale = side({ hostLabels: { a: 'Old' }, hostAppearanceStamps: { 'labels:a': { at: NOW - 20 } } });
    const one = side({ hostLabels: { a: 'Alpha' }, hostAppearanceStamps: { 'labels:a': { at: 5 } } });
    const two = side({ hostLabels: { a: 'Beta' }, hostAppearanceStamps: { 'labels:a': { at: 5 } } });

    expect(mergeHostAppearance(removed, stale, NOW).hostLabels).toEqual({});
    expect(mergeHostAppearance(one, two, NOW)).toEqual(mergeHostAppearance(two, one, NOW));
  });

  it('clamps a stamp from a clock far ahead and keeps both pin lists', () => {
    const fast = side({ hostLabels: { a: 'Fast' }, hostAppearanceStamps: { 'labels:a': { at: NOW + 86_400_000 } } });

    expect(mergeHostAppearance(fast, side(), NOW).hostAppearanceStamps['labels:a'].at).toBe(NOW + 5 * 60_000);
    expect(mergePinnedOrder(['b', 'a'], ['a', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

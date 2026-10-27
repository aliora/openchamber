import { describe, expect, test } from 'bun:test';
import { isStatusFilterListActive, pickStatusFilterZone } from './mobileStatusFilterZone';

describe('mobileStatusFilterZone', () => {
  const zones = { attention: 'attention-zone', running: 'running-zone' };

  test('picks the zone of the filter and none for All', () => {
    expect(pickStatusFilterZone('attention', zones)).toBe('attention-zone');
    expect(pickStatusFilterZone('running', zones)).toBe('running-zone');
    expect(pickStatusFilterZone('all', zones)).toBeNull();
  });

  test('the filtered list gives way to search and to editing the order', () => {
    expect(isStatusFilterListActive('running', '', false)).toBe(true);
    expect(isStatusFilterListActive('running', 'abc', false)).toBe(false);
    expect(isStatusFilterListActive('attention', '', true)).toBe(false);
    expect(isStatusFilterListActive('all', '', false)).toBe(false);
  });
});

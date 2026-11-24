import { describe, expect, test } from 'bun:test';

import { mergeProfile, type DeviceProfile } from './profile';

const NOW = Date.now();

const profileOf = (values: DeviceProfile['values'], updatedAt: DeviceProfile['updatedAt'] = {}): DeviceProfile => ({ values, updatedAt });

describe('mergeProfile with host names, icons and pin order', () => {
  test('a device back from a long absence keeps the other hosts newer names when it edits its own', () => {
    const server = {
      hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI', 'server:pi': 'Pi5 Ana' },
      hostAppearanceStamps: {
        'labels:server:mac': { at: NOW - 9_000 },
        'labels:server:msi': { at: NOW - 9_000 },
        'labels:server:pi': { at: NOW - 1_000 },
      },
    };
    const stale = profileOf(
      {
        hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi' },
        hostAppearanceStamps: {
          'labels:server:mac': { at: NOW - 9_000 },
          'labels:server:msi': { at: NOW },
          'labels:server:pi': { at: NOW - 9_000 },
        },
      },
      { hostLabels: NOW, hostAppearanceStamps: NOW },
    );

    const merge = mergeProfile(stale, server, { hostLabels: NOW - 1_000, hostAppearanceStamps: NOW - 1_000 });

    expect(merge.document.hostLabels).toEqual({ 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi5 Ana' });
    expect(merge.push.hostLabels).toEqual({ 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi5 Ana' });
    expect(merge.profile.values.hostLabels).toEqual(merge.document.hostLabels);
  });

  test('a host that sends no stamps is adopted and never written to', () => {
    const local = profileOf({ hostLabels: { 'server:a': 'Mine' }, hostAppearanceStamps: { 'labels:server:a': { at: NOW } } }, { hostLabels: NOW });

    const merge = mergeProfile(local, { hostLabels: { 'server:b': 'Theirs' } }, null);

    expect(merge.document.hostLabels).toEqual({ 'server:a': 'Mine', 'server:b': 'Theirs' });
    expect(merge.push.hostLabels).toBeUndefined();
  });

  test('pin order from both copies is kept, the newer one first', () => {
    const local = profileOf({ sidebarPinnedOrder: ['server:a#1', 'server:a#2'] }, { sidebarPinnedOrder: NOW - 5_000 });

    const merge = mergeProfile(local, { sidebarPinnedOrder: ['server:a#2', 'server:b#9'] }, { sidebarPinnedOrder: NOW });

    expect(merge.document.sidebarPinnedOrder).toEqual(['server:a#2', 'server:b#9', 'server:a#1']);
    expect(merge.push.sidebarPinnedOrder).toEqual(['server:a#2', 'server:b#9', 'server:a#1']);
    expect(merge.profile.values.sidebarPinnedOrder).toEqual(['server:a#2', 'server:b#9', 'server:a#1']);
  });
});

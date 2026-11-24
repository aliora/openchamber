import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';

import type { HostAppearance } from './host-appearance';
import { reconcileHostAppearance } from './host-appearance-sync';
import { profileFanOut } from './profile-fan-out';

const NOW = Date.now();

const targetServing = (settings: Partial<HostAppearance>) => ({
  fetch: async () => ({ ok: true as const, response: new Response(JSON.stringify(settings)) }),
});

describe('reconcileHostAppearance', () => {
  beforeEach(() => {
    useUIStore.setState({
      hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI', 'server:pi': 'Pi' },
      hostLogos: {},
      hostAppearanceStamps: {
        'labels:server:mac': { at: NOW - 9_000 },
        'labels:server:msi': { at: NOW - 9_000 },
        'labels:server:pi': { at: NOW - 9_000 },
      },
    });
  });

  afterEach(() => profileFanOut.cancel());

  test('a device back from absence learns the newer name before its own edit and then edits only its own host', async () => {
    await reconcileHostAppearance(targetServing({
      hostLabels: { 'server:mac': 'Mac', 'server:msi': 'MSI', 'server:pi': 'Pi5 Ana' },
      hostAppearanceStamps: { 'labels:server:pi': { at: NOW - 1_000 }, 'labels:server:mac': { at: NOW - 9_000 }, 'labels:server:msi': { at: NOW - 9_000 } },
    }));

    useUIStore.getState().setHostLabel('server:msi', 'MSI Oyun');

    expect(useUIStore.getState().hostLabels).toEqual({ 'server:mac': 'Mac', 'server:msi': 'MSI Oyun', 'server:pi': 'Pi5 Ana' });
  });

  test('keeps what only this device knows so the host can be brought up to date', async () => {
    useUIStore.getState().setHostLabel('server:msi', 'MSI Oyun');

    await reconcileHostAppearance(targetServing({ hostLabels: { 'server:pi': 'Pi' }, hostAppearanceStamps: {} }));

    expect(useUIStore.getState().hostLabels['server:msi']).toBe('MSI Oyun');
  });

  test('an unreachable host changes nothing', async () => {
    await reconcileHostAppearance({ fetch: async () => ({ ok: false as const, reason: 'unreachable' as const }) });

    expect(useUIStore.getState().hostLabels['server:pi']).toBe('Pi');
  });
});

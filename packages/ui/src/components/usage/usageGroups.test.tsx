import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUsageProviderGroups } from './usageGroups';

let visibleProviders = '';
let visibleRows = 0;
let visibleStatus: string | null = null;
const Probe = () => {
  const groups = useUsageProviderGroups();
  visibleProviders = groups.map((group) => group.providerId).join(',');
  visibleRows = groups.reduce((count, group) => count + group.rows.length, 0);
  visibleStatus = groups[0]?.status ?? null;
  return null;
};

test('usage follows active-account quota results and never reads a session binding', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const previous = useQuotaStore.getState().results;
  const network = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Session account reads are obsolete'); });
  try {
    useQuotaStore.setState({ results: [{ providerId: 'claude', providerName: 'Claude', ok: true, configured: true, usage: { windows: { session: { usedPercent: 20, remainingPercent: 80, windowSeconds: null, resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null } } }, fetchedAt: 1 }] });
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    expect(visibleProviders).toBe('claude');
    expect(visibleRows).toBe(1);
    await act(async () => useQuotaStore.setState({ results: [{ providerId: 'claude', providerName: 'Claude', accountId: 'work', ok: false, configured: true, usage: null, error: 'Profile quota unavailable', fetchedAt: 2 }] }));
    expect(visibleProviders).toBe('claude');
    expect(visibleRows).toBe(0);
    expect(visibleStatus).toBe('Profile quota unavailable');
    expect(network.mock.calls.length).toBe(0);
  } finally {
    await act(async () => root.unmount());
    network.mockRestore();
    useQuotaStore.setState({ results: previous });
    dom.restore();
  }
});


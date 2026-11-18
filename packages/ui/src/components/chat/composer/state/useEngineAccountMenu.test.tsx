import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { resolveHost } from '@/lib/hosts/runtime/host-bindings';
import { subscribeEngineAccountChanges, type EngineAccount } from '@/lib/engineAccounts';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { useEngineAccountMenu } from './useEngineAccountMenu';

type Fixture = { engine: string; accounts: EngineAccount[]; supported?: boolean; signedIn?: Set<string> };

const renderMenu = async (fixture: Fixture) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const host = resolveHost();
  const controls = useEngineControlsStore.getState().catalog;
  const requests: string[] = [];
  let accounts = fixture.accounts;
  const network = spyOn(host.transport, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/auth/status')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-3) ?? '');
      return Response.json({ loggedIn: fixture.signedIn?.has(id) ?? true, email: null });
    }
    if (url.pathname.endsWith('/default') && init?.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      accounts = accounts.map((account) => ({ ...account, isDefault: account.id === id }));
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/accounts')) return Response.json({ supported: fixture.supported ?? true, data: accounts });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const quota = spyOn(useQuotaStore.getState(), 'fetchProviderQuota').mockResolvedValue(true);
  useEngineControlsStore.setState({ catalog: { defaultEngine: 'claude', engines: [{ engine: fixture.engine, providerID: 'provider', defaultPermissionMode: 'ask', permissionModes: [], defaultEffort: null }] } });
  let menu: ReturnType<typeof useEngineAccountMenu> = null;
  const Probe = () => {
    menu = useEngineAccountMenu('provider');
    return null;
  };
  await act(async () => root.render(<Probe />));
  return {
    host, requests, quota,
    current: (): ReturnType<typeof useEngineAccountMenu> => menu,
    cleanup: async () => {
      await act(async () => root.unmount());
      quota.mockRestore();
      network.mockRestore();
      useEngineControlsStore.setState({ catalog: controls });
      dom.restore();
    },
  };
};

const twoAccounts: EngineAccount[] = [
  { id: 'default', label: 'Personal', isDefault: false },
  { id: 'work', label: 'Work', isDefault: true },
];

test('lists the engine accounts and marks the active one', async () => {
  const view = await renderMenu({ engine: 'claude', accounts: twoAccounts });
  try {
    expect(view.current()?.accounts.map((account) => account.label)).toEqual(['Personal', 'Work']);
    expect(view.current()?.active?.id).toBe('work');
  } finally { await view.cleanup(); }
});

test('names the engine the accounts belong to, with the name chosen in Settings', async () => {
  const appearance = useUIStore.getState().engineAppearance;
  try {
    const view = await renderMenu({ engine: 'claude', accounts: twoAccounts });
    try { expect(view.current()?.engineView.name).toBe('Claude Code'); } finally { await view.cleanup(); }
    useUIStore.setState({ engineAppearance: { codex: { name: 'Work Codex' } } });
    const renamed = await renderMenu({ engine: 'codex', accounts: twoAccounts });
    try { expect(renamed.current()?.engineView.name).toBe('Work Codex'); } finally { await renamed.cleanup(); }
  } finally { useUIStore.setState({ engineAppearance: appearance }); }
});

test('stays hidden for a single account and for engines without accounts', async () => {
  for (const fixture of [
    { engine: 'codex', accounts: [twoAccounts[1]] },
    { engine: 'antigravity', accounts: twoAccounts },
    { engine: 'opencode', accounts: twoAccounts },
    { engine: 'claude', accounts: twoAccounts, supported: false },
  ]) {
    const view = await renderMenu(fixture);
    try { expect(view.current()).toBeNull(); } finally { await view.cleanup(); }
  }
});

test('switching uses the Settings account endpoint, announces the change and refreshes quota', async () => {
  const view = await renderMenu({ engine: 'codex', accounts: twoAccounts });
  let announced = 0;
  const unsubscribe = view.host.run(() => subscribeEngineAccountChanges(() => { announced += 1; }));
  try {
    let result: string | undefined;
    await act(async () => { result = await view.current()?.select('default'); });
    expect(result).toBe('switched');
    expect(view.requests).toContain('POST /api/engines/codex/accounts/default/default');
    expect(announced).toBeGreaterThan(0);
    expect(view.quota.mock.calls.some(([engine, invalidate]) => engine === 'codex' && invalidate === true)).toBe(true);
    expect(view.current()?.active?.id).toBe('default');
  } finally { unsubscribe(); await view.cleanup(); }
});

test('a signed-out account is not activated and asks for sign-in', async () => {
  const view = await renderMenu({ engine: 'claude', accounts: twoAccounts, signedIn: new Set(['work']) });
  try {
    let result: string | undefined;
    await act(async () => { result = await view.current()?.select('default'); });
    expect(result).toBe('sign-in-required');
    expect(view.requests.some((request) => request.startsWith('POST'))).toBe(false);
    expect(view.current()?.active?.id).toBe('work');
  } finally { await view.cleanup(); }
});

test('selecting the active account changes nothing', async () => {
  const view = await renderMenu({ engine: 'claude', accounts: twoAccounts });
  try {
    let result: string | undefined;
    await act(async () => { result = await view.current()?.select('work'); });
    expect(result).toBe('unchanged');
    expect(view.requests.some((request) => request.startsWith('POST'))).toBe(false);
  } finally { await view.cleanup(); }
});

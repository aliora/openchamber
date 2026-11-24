import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { resolveHost } from '@/lib/hosts/runtime/host-bindings';
import { readDraftEngineAccount, setDraftEngineAccount, subscribeEngineAccountChanges, type EngineAccount } from '@/lib/engineAccounts';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEngineAccountMenu } from './useEngineAccountMenu';

type Fixture = { engine: string; accounts: EngineAccount[]; supported?: boolean; signedIn?: Set<string>; session?: { id: string; accountId: string } };

const renderMenu = async (fixture: Fixture) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const host = resolveHost();
  const controls = useEngineControlsStore.getState().catalog;
  const currentSessionId = useSessionUIStore.getState().currentSessionId;
  const requests: string[] = [];
  const accounts = fixture.accounts;
  let sessionAccountId = fixture.session?.accountId;
  const network = spyOn(host.transport, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/auth/status')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-3) ?? '');
      return Response.json({ loggedIn: fixture.signedIn?.has(id) ?? true, email: null });
    }
    if (fixture.session && url.pathname === `/api/session/${fixture.session.id}/account` && init?.method === 'POST') {
      sessionAccountId = JSON.parse(String(init.body)).accountId;
    }
    if (fixture.session && url.pathname.startsWith(`/api/session/${fixture.session.id}`)) {
      const label = accounts.find((account) => account.id === sessionAccountId)?.label;
      return Response.json({ data: { engine: fixture.engine, accountId: sessionAccountId, accountLabel: label } });
    }
    if (url.pathname.endsWith('/accounts')) return Response.json({ supported: fixture.supported ?? true, data: accounts });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  useSessionUIStore.setState({ currentSessionId: fixture.session?.id ?? null });
  useEngineControlsStore.setState({ catalog: { defaultEngine: 'claude', engines: [{ engine: fixture.engine, providerID: 'provider', defaultPermissionMode: 'ask', permissionModes: [], defaultEffort: null }] } });
  let menu: ReturnType<typeof useEngineAccountMenu> = null;
  const Probe = () => {
    menu = useEngineAccountMenu('provider');
    return null;
  };
  await act(async () => root.render(<Probe />));
  return {
    host, requests,
    current: (): ReturnType<typeof useEngineAccountMenu> => menu,
    cleanup: async () => {
      await act(async () => root.unmount());
      network.mockRestore();
      host.run(() => setDraftEngineAccount(fixture.engine, null));
      useSessionUIStore.setState({ currentSessionId });
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

test('in an open session, switching moves only that session and leaves the default alone', async () => {
  const view = await renderMenu({ engine: 'codex', accounts: twoAccounts, session: { id: 'ses_1', accountId: 'work' } });
  let announced = 0;
  const unsubscribe = view.host.run(() => subscribeEngineAccountChanges(() => { announced += 1; }));
  try {
    expect(view.current()?.active?.id).toBe('work');
    expect(view.current()?.scope).toBe('session');
    let result: string | undefined;
    await act(async () => { result = await view.current()?.select('default'); });
    expect(result).toBe('switched');
    expect(view.requests).toContain('POST /api/session/ses_1/account');
    expect(view.requests.some((request) => request.includes('/accounts/default/default'))).toBe(false);
    expect(announced).toBeGreaterThan(0);
    expect(view.current()?.active?.id).toBe('default');
  } finally { unsubscribe(); await view.cleanup(); }
});

test('in a draft, switching keeps the pick for the session the draft becomes', async () => {
  const view = await renderMenu({ engine: 'codex', accounts: twoAccounts });
  try {
    expect(view.current()?.scope).toBe('draft');
    let result: string | undefined;
    await act(async () => { result = await view.current()?.select('default'); });
    expect(result).toBe('switched');
    expect(view.requests.some((request) => request.startsWith('POST'))).toBe(false);
    expect(view.host.run(() => readDraftEngineAccount('codex'))).toBe('default');
    expect(view.current()?.active?.id).toBe('default');
  } finally { await view.cleanup(); }
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

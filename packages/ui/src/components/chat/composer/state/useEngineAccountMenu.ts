import React from 'react';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { useComposerEngineAccount } from '@/hooks/useSessionEngineAccount';
import {
  changeSessionEngineAccount,
  fetchEngineAccountAuth,
  fetchEngineAccounts,
  isMultiAccountEngine,
  setDraftEngineAccount,
  subscribeEngineAccountChanges,
  type EngineAccount,
  type MultiAccountEngine,
} from '@/lib/engineAccounts';
import { resolveEngineView } from '@/lib/engineAppearance';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useUIStore } from '@/stores/useUIStore';

export type EngineAccountSelectResult = 'switched' | 'unchanged' | 'sign-in-required';

/**
 * The composer's account menu: the account of the open session, or in a draft
 * the account the new session starts on. Settings → Engines only sets the
 * default new sessions start on. Null when the engine has one account or no accounts at all.
 */
export const useEngineAccountMenu = (providerId: string | null | undefined) => {
  const host = useScopedHostRuntime();
  const engine = useEngineControlsStore((state) => state.catalog?.engines.find((entry) => entry.providerID === providerId)?.engine);
  const appearance = useUIStore((state) => state.engineAppearance);
  const composer = useComposerEngineAccount(engine);
  const [revision, setRevision] = React.useState(0);
  const [accounts, setAccounts] = React.useState<{ engine: MultiAccountEngine; data: EngineAccount[] } | null>(null);
  React.useEffect(() => host.run(() => subscribeEngineAccountChanges(() => setRevision((value) => value + 1))), [host]);
  React.useEffect(() => {
    let disposed = false;
    setAccounts(null);
    if (!isMultiAccountEngine(engine)) return;
    void host.run(() => fetchEngineAccounts(engine)).then((next) => {
      if (!disposed && !host.disposed && next.supported) setAccounts({ engine, data: next.data });
    }, () => undefined);
    return () => { disposed = true; };
  }, [host, engine, revision]);

  const activeId = composer?.accountId ?? accounts?.data.find((account) => account.isDefault)?.id;
  const sessionId = composer?.sessionId ?? null;
  const select = React.useCallback(async (accountId: string): Promise<EngineAccountSelectResult> => {
    const target = accounts?.data.find((account) => account.id === accountId);
    if (!accounts || !target || target.id === activeId) return 'unchanged';
    const auth = await host.run(() => fetchEngineAccountAuth(accounts.engine, accountId));
    if (!auth.loggedIn) return 'sign-in-required';
    if (sessionId) await host.run(() => changeSessionEngineAccount(sessionId, accountId));
    else host.run(() => setDraftEngineAccount(accounts.engine, target.isDefault ? null : accountId));
    return 'switched';
  }, [host, accounts, activeId, sessionId]);

  const visible = composer && accounts && accounts.engine === engine && accounts.data.length > 1;
  if (!visible) return null;
  return {
    engine: accounts.engine,
    engineView: resolveEngineView(accounts.engine, appearance),
    accounts: accounts.data,
    active: accounts.data.find((account) => account.id === activeId) ?? null,
    scope: sessionId ? 'session' as const : 'draft' as const,
    select,
  };
};

import React from 'react';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { changeEngineAccount, fetchEngineAccountAuth, fetchEngineAccounts, notifyEngineAccountsChanged, subscribeEngineAccountChanges, type EngineAccount } from '@/lib/engineAccounts';
import { resolveEngineView } from '@/lib/engineAppearance';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';

const MULTI_ACCOUNT_ENGINES = ['claude', 'codex'] as const;
type MultiAccountEngine = typeof MULTI_ACCOUNT_ENGINES[number];
export type EngineAccountSelectResult = 'switched' | 'unchanged' | 'sign-in-required';

const isMultiAccountEngine = (engine: string | undefined): engine is MultiAccountEngine =>
  MULTI_ACCOUNT_ENGINES.some((candidate) => candidate === engine);

/**
 * The composer's account menu: the same host-wide active account Settings → Engines manages.
 * Null when the engine has one account or no accounts at all.
 */
export const useEngineAccountMenu = (providerId: string | null | undefined) => {
  const host = useScopedHostRuntime();
  const engine = useEngineControlsStore((state) => state.catalog?.engines.find((entry) => entry.providerID === providerId)?.engine);
  const appearance = useUIStore((state) => state.engineAppearance);
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

  const select = React.useCallback(async (accountId: string): Promise<EngineAccountSelectResult> => {
    const target = accounts?.data.find((account) => account.id === accountId);
    if (!accounts || !target || target.isDefault) return 'unchanged';
    const auth = await host.run(() => fetchEngineAccountAuth(accounts.engine, accountId));
    if (!auth.loggedIn) return 'sign-in-required';
    await host.run(() => changeEngineAccount(accounts.engine, 'default', accountId));
    host.run(notifyEngineAccountsChanged);
    await host.run(() => useQuotaStore.getState().fetchProviderQuota(accounts.engine, true));
    return 'switched';
  }, [host, accounts]);

  const visible = accounts && accounts.engine === engine && accounts.data.length > 1;
  if (!visible) return null;
  return { engine: accounts.engine, engineView: resolveEngineView(accounts.engine, appearance), accounts: accounts.data, active: accounts.data.find((account) => account.isDefault) ?? null, select };
};

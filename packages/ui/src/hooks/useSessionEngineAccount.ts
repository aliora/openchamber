import React from 'react';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { useI18n } from '@/lib/i18n';
import {
  engineAccountName,
  fetchEngineAccounts,
  fetchSessionEngineAccount,
  MULTI_ACCOUNT_ENGINES,
  readDraftEngineAccount,
  subscribeEngineAccountChanges,
  type SessionEngineAccount,
} from '@/lib/engineAccounts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const useEngineAccountRevision = () => {
  const host = useScopedHostRuntime();
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => host.run(() => subscribeEngineAccountChanges(() => setRevision((value) => value + 1))), [host]);
  return revision;
};

/** The account the open session is bound to, read again whenever an account changes or `refreshKey` does. */
export const useSessionEngineAccount = (sessionId: string | null, refreshKey?: string) => {
  const host = useScopedHostRuntime();
  const revision = useEngineAccountRevision();
  const [loaded, setLoaded] = React.useState<{ sessionId: string; account: SessionEngineAccount } | null>(null);
  React.useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void host.run(() => fetchSessionEngineAccount(sessionId)).then((account) => {
      if (!disposed && !host.disposed) setLoaded({ sessionId, account });
    }, () => undefined);
    return () => { disposed = true; };
  }, [host, sessionId, revision, refreshKey]);
  return sessionId && loaded?.sessionId === sessionId ? loaded.account : null;
};

export type ComposerEngineAccount = {
  sessionId: string | null;
  /** Undefined runs on the host default; a session on another engine than `engine` gets its default too. */
  accountId: string | undefined;
};

/**
 * The account the composer's next turn runs on for `engine`: the open session's
 * own account, or in a draft the account picked for the session it becomes.
 * Null while the open session's account is still being read.
 */
export const useComposerEngineAccount = (engine: string | undefined): ComposerEngineAccount | null => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const host = useScopedHostRuntime();
  useEngineAccountRevision();
  const session = useSessionEngineAccount(sessionId, engine);
  if (!sessionId) return { sessionId: null, accountId: engine ? host.run(() => readDraftEngineAccount(engine)) : undefined };
  if (!session) return null;
  return { sessionId, accountId: session.engine === engine ? session.accountId : undefined };
};

/** Points the usage readouts at the accounts the open session, or the draft, runs on. */
export const useSessionQuotaScope = () => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const host = useScopedHostRuntime();
  const revision = useEngineAccountRevision();
  const session = useSessionEngineAccount(sessionId);
  const setAccountScope = useQuotaStore((state) => state.setAccountScope);
  React.useEffect(() => {
    if (sessionId && !session) return;
    for (const engine of MULTI_ACCOUNT_ENGINES) {
      const accountId = sessionId
        ? (session?.engine === engine ? session.accountId : undefined)
        : host.run(() => readDraftEngineAccount(engine));
      setAccountScope(engine, accountId);
    }
  }, [host, sessionId, session, revision, setAccountScope]);
};

/** Account names by `engine:accountId`, so a usage readout can say whose limits it shows. */
export const useEngineAccountLabels = (): ReadonlyMap<string, string> => {
  const host = useScopedHostRuntime();
  const revision = useEngineAccountRevision();
  const [labels, setLabels] = React.useState<ReadonlyMap<string, string>>(new Map());
  React.useEffect(() => {
    let disposed = false;
    void Promise.all(MULTI_ACCOUNT_ENGINES.map(async (engine) => {
      const accounts = await host.run(() => fetchEngineAccounts(engine)).catch(() => null);
      return (accounts?.data ?? []).map((account) => [`${engine}:${account.id}`, account.label] as const);
    })).then((entries) => {
      if (!disposed && !host.disposed) setLabels(new Map(entries.flat()));
    });
    return () => { disposed = true; };
  }, [host, revision]);
  return labels;
};

/**
 * The name to show for an engine account. The ambient account gets its own
 * name, so it cannot be read as the "default for new chats" marker.
 */
export const useEngineAccountName = () => {
  const { t } = useI18n();
  const labels = useEngineAccountLabels();
  return React.useCallback((engine: string, accountId: string) => {
    const label = labels.get(`${engine}:${accountId}`);
    return label === undefined ? undefined : engineAccountName({ id: accountId, label }, t('engines.accounts.ambient'));
  }, [labels, t]);
};

/**
 * Whose account a one-off generation runs on: the open session's, or in a
 * draft the account picked for the composer's engine; with neither, the host
 * default.
 */
export const readGenerationScope = () => {
  const sessionID = useSessionUIStore.getState().currentSessionId;
  if (sessionID) return { sessionID };
  const providerID = useConfigStore.getState().currentProviderId;
  const engine = useEngineControlsStore.getState().catalog?.engines.find((entry) => entry.providerID === providerID)?.engine;
  const accountId = engine ? readDraftEngineAccount(engine) : undefined;
  return accountId ? { account: `${engine}:${accountId}` } : {};
};

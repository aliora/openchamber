import React from 'react';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { fetchEngineAccounts, subscribeEngineAccountChanges } from '@/lib/engineAccounts';
import type { ProviderCatalog } from '@/lib/opencode/client';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { fetchEngineReadiness, type EngineReadinessRead } from '@/stores/useEngineReadinessStore';

/** Every composer uses the selected host's active engine account for its next turn. */
export const useEngineAccountCatalog = (providerId: string | null | undefined, directory: string | null | undefined, open: boolean) => {
  const host = useScopedHostRuntime();
  const engine = useEngineControlsStore((state) => state.catalog?.engines.find((entry) => entry.providerID === providerId)?.engine);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => host.run(() => subscribeEngineAccountChanges(() => setRevision((value) => value + 1))), [host]);
  const [snapshot, setSnapshot] = React.useState<{ catalog: ProviderCatalog | null; readiness: EngineReadinessRead | null } | null>(null);
  React.useEffect(() => {
    let disposed = false;
    setSnapshot(null);
    if (!engine) return;
    const load = async () => {
      const accounts = await host.run(() => fetchEngineAccounts(engine));
      if (!accounts.supported) return;
      const selectedId = accounts.data.find((entry) => entry.isDefault)?.id;
      if (!selectedId) throw new Error('The engine has no active account');
      const account = { engine, accountId: selectedId };
      const [catalog, readiness] = await Promise.all([
        host.client.getProvidersForConfig(directory, { account, fresh: open || revision > 0 }),
        host.run(() => fetchEngineReadiness(account)),
      ]);
      if (!disposed && !host.disposed) setSnapshot({ catalog, readiness });
    };
    void load().catch(() => {
      if (disposed || host.disposed || !providerId) return;
      const readiness: EngineReadinessRead = { ready: new Set(), unavailable: new Map([[providerId, { reason: 'catalog-error', fixCommand: null }]]), pending: false };
      setSnapshot({ catalog: null, readiness });
    });
    return () => { disposed = true; };
  }, [host, engine, directory, open, providerId, revision]);
  return snapshot;
};

import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { resolveHost } from '@/lib/hosts/runtime/host-bindings';
import { createHostRegistry } from '@/lib/hosts/runtime/host-registry';
import { notifyEngineAccountsChanged } from '@/lib/engineAccounts';
import type { ProviderCatalog } from '@/lib/opencode/client';
import { catalogRefreshTasks } from '@/stores/catalogRefresh';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEngineAccountCatalog } from './useEngineAccountCatalog';

test('an open chat lists the models of its own account, not the host default, and rejects stale catalog reads', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const host = resolveHost();
  const controls = useEngineControlsStore.getState().catalog;
  const session = useSessionUIStore.getState();
  let sessionAccount = 'work';
  const network = spyOn(host.transport, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    if (url.pathname.endsWith('/accounts')) return Response.json({ supported: true, data: [
      { id: 'default', label: 'Personal', isDefault: true },
      { id: 'work', label: 'Work', isDefault: false },
    ] });
    if (url.pathname === '/api/session/existing-chat') return Response.json({ data: { engine: 'claude', accountId: sessionAccount, accountLabel: sessionAccount } });
    if (url.pathname.endsWith('/readiness')) return Response.json({ data: [{ providerID: 'claude', state: 'ready', fixCommand: null }] });
    throw new Error(`Unexpected account request ${url.pathname}`);
  });
  let finishOld: (catalog: ProviderCatalog) => void = () => undefined;
  const oldCatalog = new Promise<ProviderCatalog>((resolve) => { finishOld = resolve; });
  const catalogFor = (id: string): ProviderCatalog => ({ providers: [], models: [], default: { providerID: 'claude', id } });
  const reads: string[] = [];
  const client = spyOn(host.client, 'getProvidersForConfig').mockImplementation(async (_directory, options) => {
    const account = options?.account?.accountId ?? '';
    reads.push(account);
    return account === 'work' ? oldCatalog : catalogFor(account);
  });
  const providers = spyOn(useConfigStore.getState(), 'loadProviders').mockResolvedValue(undefined);
  let snapshot: ReturnType<typeof useEngineAccountCatalog> = null;
  const Probe = () => {
    snapshot = useEngineAccountCatalog('claude', '/repo', false);
    return null;
  };
  try {
    useEngineControlsStore.setState({ catalog: { defaultEngine: 'claude', engines: [{ engine: 'claude', providerID: 'claude', defaultPermissionMode: 'ask', permissionModes: [], defaultEffort: null }] } });
    // Old drafts and the previous session's account do not select a catalog.
    const legacyDraft = { ...session.newSessionDraft, engineAccount: { engine: 'claude', accountId: 'obsolete' } };
    useSessionUIStore.setState({ currentSessionId: 'existing-chat', newSessionDraft: legacyDraft });
    await act(async () => root.render(<Probe />));
    expect(reads).toEqual(['work']);

    const otherRegistry = createHostRegistry(() => ({ transport: host.transport, client: host.client }));
    const other = otherRegistry.register({ descriptor: { id: 'other', label: 'Other', kind: 'local', displayUrl: '', runtimeKey: 'host:other', monitored: false }, endpoint: { kind: 'local', apiUrl: '' } }, async () => null);
    await act(async () => other.run(notifyEngineAccountsChanged));
    expect(reads).toEqual(['work']);

    sessionAccount = 'default';
    await act(async () => { await host.run(() => catalogRefreshTasks('model')[0]()); });
    expect(reads.at(-1)).toBe('default');
    const current = (): ReturnType<typeof useEngineAccountCatalog> => snapshot;
    expect(current()?.catalog?.default?.id).toBe('default');
    await act(async () => finishOld(catalogFor('work')));
    expect(current()?.catalog?.default?.id).toBe('default');
  } finally {
    await act(async () => root.unmount());
    providers.mockRestore();
    client.mockRestore();
    network.mockRestore();
    useEngineControlsStore.setState({ catalog: controls });
    useSessionUIStore.setState({ currentSessionId: session.currentSessionId, newSessionDraft: session.newSessionDraft });
    dom.restore();
  }
});

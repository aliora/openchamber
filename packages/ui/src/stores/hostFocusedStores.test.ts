import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { runWithHost } from '@/lib/hosts/runtime/ambient-host';
import { hostRegistry, resolveHost } from '@/lib/hosts/runtime/app-host';
import type { HostBoundStore, HostRuntime } from '@/lib/hosts/runtime/types';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { useGuestsStore } from '@/lib/guests/store';
import { opencodeClient } from '@/lib/opencode/client';
import type { McpServerStatus } from '@/lib/opencode/model';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { refreshStoresForCatalogKind } from './catalogRefresh';
import { useAgentMemoryStore } from './useAgentMemoryStore';
import { useAgentsStore } from './useAgentsStore';
import { useChangeRequestContextStore } from './useChangeRequestContextStore';
import { useCommandsStore } from './useCommandsStore';
import { useEngineControlsStore } from './useEngineControlsStore';
import { useEngineReadinessStore } from './useEngineReadinessStore';
import { useFileSearchStore } from './useFileSearchStore';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { useGitHubPrStatusStore } from './useGitHubPrStatusStore';
import { useGitIdentitiesStore } from './useGitIdentitiesStore';
import { useGitStore } from './useGitStore';
import { useLinearAuthStore } from './useLinearAuthStore';
import { useMcpStore } from './useMcpStore';
import { useQuotaStore } from './useQuotaStore';
import { useSkillsStore } from './useSkillsStore';
import { useSourceControlAuthStore } from './useSourceControlAuthStore';
import { useTerminalStore } from './useTerminalStore';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const registerHost = (id: string): HostRuntime => hostRegistry.register({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `https://${id}.example/`, runtimeKey: id, monitored: false },
  endpoint: { kind: 'direct', apiUrl: `https://${id}.example` },
}, async () => null);

const expectOneCopyPerHost = <S,>(store: HostBoundStore<S>, first: HostRuntime, second: HostRuntime): void => {
  const secondBefore = store.forHost(second.id).getState();
  store.forHost(first.id).setState({});
  expect(store.forHost(first.id)).not.toBe(store.forHost(second.id));
  expect(store.forHost(second.id).getState()).toBe(secondBefore);
  expect(runWithHost(second, store.getState)).toBe(secondBefore);
};

const connected = (name: string): McpServerStatus[] => [{ name, status: { status: 'connected' } }];

describe('the stores that serve the focused host', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const originalListCommands = opencodeClient.listCommands;
  const originalListMcpServers = opencodeClient.listMcpServers;
  let focused: HostRuntime;
  let other: HostRuntime;

  beforeAll(() => {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const setUpHosts = () => {
    focused = resolveHost();
    other = registerHost('host:other');
  };

  afterEach(() => {
    opencodeClient.listCommands = originalListCommands;
    opencodeClient.listMcpServers = originalListMcpServers;
    hostRegistry.focus(focused.id);
    hostRegistry.unregister(other.id);
  });

  test('keep one copy per host in the catalog family', () => {
    setUpHosts();
    expectOneCopyPerHost(useCommandsStore, focused, other);
    expectOneCopyPerHost(useAgentsStore, focused, other);
    expectOneCopyPerHost(useMcpStore, focused, other);
    expectOneCopyPerHost(useSkillsStore, focused, other);
    expectOneCopyPerHost(useQuotaStore, focused, other);
    expectOneCopyPerHost(useEngineReadinessStore, focused, other);
    expectOneCopyPerHost(useEngineControlsStore, focused, other);
    expectOneCopyPerHost(useAgentMemoryStore, focused, other);
  });

  test('keep one copy per host in the source control family', () => {
    setUpHosts();
    expectOneCopyPerHost(useGitStore, focused, other);
    expectOneCopyPerHost(useGitIdentitiesStore, focused, other);
    expectOneCopyPerHost(useSourceControlAuthStore, focused, other);
    expectOneCopyPerHost(useChangeRequestContextStore, focused, other);
    expectOneCopyPerHost(useGitHubPrStatusStore, focused, other);
    expectOneCopyPerHost(useLinearAuthStore, focused, other);
    const scope = runWithHost(focused, () => repositoryBindingOwner.scope('/repo'));
    runWithHost(focused, () => repositoryBindingOwner.reset());
    expect(runWithHost(focused, () => repositoryBindingOwner.generation)).toBe(scope.generation + 1);
    expect(runWithHost(other, () => repositoryBindingOwner.generation)).toBe(0);
  });

  test('keep one copy per host for guests, file search, file tabs and terminals', () => {
    setUpHosts();
    expectOneCopyPerHost(useGuestsStore, focused, other);
    expectOneCopyPerHost(useGuestOauthStore, focused, other);
    expectOneCopyPerHost(useFileSearchStore, focused, other);
    expectOneCopyPerHost(useFilesViewTabsStore, focused, other);
    expectOneCopyPerHost(useTerminalStore, focused, other);
    runWithHost(focused, () => useTerminalStore.getState().ensureDirectory('/repo'));
    expect(useTerminalStore.forHost(focused.id).getState().sessions.has('/repo')).toBe(true);
    expect(useTerminalStore.forHost(other.id).getState().sessions.size).toBe(0);
  });

  test('keep the file tabs each host saved when the hosts write in turn', () => {
    setUpHosts();
    const select = (host: HostRuntime, path: string) => useFilesViewTabsStore.forHost(host.id).getState().setSelectedPath('/repo', path);
    select(focused, '/repo/a.ts');
    select(other, '/repo/b.ts');
    select(focused, '/repo/c.ts');

    const otherScope = other.storeScope;
    hostRegistry.unregister(other.id);
    hostRegistry.unregister(registerHost('host:third').id);
    other = registerHost('host:other');

    expect(other.storeScope).not.toBe(otherScope);
    expect(useFilesViewTabsStore.forHost(other.id).getState().byRoot['/repo']?.selectedPath).toBe('/repo/b.ts');
    expect(useFilesViewTabsStore.forHost(focused.id).getState().byRoot['/repo']?.selectedPath).toBe('/repo/c.ts');
  });

  test('land a load that finishes after the focus moved in the host that started it', async () => {
    setUpHosts();
    const commands = deferred<Awaited<ReturnType<typeof opencodeClient.listCommands>>>();
    const servers = deferred<McpServerStatus[]>();
    opencodeClient.listCommands = () => commands.promise;
    opencodeClient.listMcpServers = () => servers.promise;

    const commandsLoad = useCommandsStore.getState().loadCommands('/late');
    const mcpLoad = useMcpStore.getState().refresh({ directory: '/late', silent: true });
    hostRegistry.focus(other.id);
    commands.resolve([{ name: 'build' }]);
    servers.resolve(connected('late-server'));
    await Promise.all([commandsLoad, mcpLoad]);

    expect(useCommandsStore.forHost(focused.id).getState().commandsByDirectory['/late']?.map((command) => command.name)).toEqual(['build']);
    expect(useCommandsStore.getState().commandsByDirectory['/late']).toBeUndefined();
    expect(Object.keys(useMcpStore.forHost(focused.id).getState().byDirectory['/late'] ?? {})).toEqual(['late-server']);
    expect(useMcpStore.getState().byDirectory['/late']).toBeUndefined();
  });

  test('mark a catalog stale for a background host and re-read it when the host is focused', async () => {
    setUpHosts();
    const reads: string[] = [];
    opencodeClient.listCommands = async () => {
      reads.push(resolveHost().id);
      return [{ name: 'deploy' }];
    };

    await runWithHost(other, () => refreshStoresForCatalogKind('command'));
    expect(reads).toEqual([]);

    hostRegistry.focus(other.id);
    for (let attempt = 0; attempt < 20 && reads.length === 0; attempt += 1) await settle();
    await settle();

    expect(reads).toEqual([other.id]);
    expect(useCommandsStore.forHost(other.id).getState().commands.map((command) => command.name)).toEqual(['deploy']);
    expect(useCommandsStore.forHost(focused.id).getState().commands.some((command) => command.name === 'deploy')).toBe(false);

    hostRegistry.focus(focused.id);
    hostRegistry.focus(other.id);
    await settle();
    expect(reads).toEqual([other.id]);
  });

  test('re-read an MCP status announced for a background host when that host is focused', async () => {
    setUpHosts();
    const reads: string[] = [];
    opencodeClient.listMcpServers = async () => {
      reads.push(resolveHost().id);
      return connected('announced');
    };
    useMcpStore.forHost(other.id).setState({ byDirectory: { '/held': {} } });

    await runWithHost(other, () => useMcpStore.getState().refreshIfHeld('/held'));
    expect(reads).toEqual([]);

    hostRegistry.focus(other.id);
    for (let attempt = 0; attempt < 20 && reads.length === 0; attempt += 1) await settle();
    await settle();

    expect(reads).toEqual([other.id]);
    expect(Object.keys(useMcpStore.forHost(other.id).getState().byDirectory['/held'] ?? {})).toEqual(['announced']);
  });
});

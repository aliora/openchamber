import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useEngineSetupStore } from './useEngineSetupStore';
import type { EngineStatus } from './engineSetupModel';

const codex: EngineStatus = {
  engine: 'codex', displayName: 'Codex', providerID: 'openai', installed: true, version: '0.162.1',
  latestVersion: null, updateAvailable: false, canInstall: true, installCommand: 'npm install -g @openai/codex',
  state: 'idle', lastError: null,
};

beforeEach(() => useEngineSetupStore.setState({ snapshots: new Map(), loaded: false, error: null, loginMessage: new Map() }));

describe('useEngineSetupStore.refresh', () => {
  test('joins status and readiness per engine', async () => {
    await useEngineSetupStore.getState().refresh({
      statuses: async () => [codex],
      readiness: async () => new Map([['codex', { state: 'signed-out', fixCommand: 'codex login' }]]),
    });
    const snapshot = useEngineSetupStore.getState().snapshots.get('codex');
    expect(snapshot?.readiness).toBe('signed-out');
    expect(snapshot?.fixCommand).toBe('codex login');
    expect(useEngineSetupStore.getState().loaded).toBe(true);
  });

  test('an engine missing from readiness is unknown', async () => {
    await useEngineSetupStore.getState().refresh({ statuses: async () => [codex], readiness: async () => new Map() });
    expect(useEngineSetupStore.getState().snapshots.get('codex')?.readiness).toBe('unknown');
  });

  test('a failed read keeps the last snapshots and records the error', async () => {
    await useEngineSetupStore.getState().refresh({ statuses: async () => [codex], readiness: async () => new Map() });
    await useEngineSetupStore.getState().refresh({ statuses: async () => { throw new Error('down'); }, readiness: async () => new Map() });
    expect(useEngineSetupStore.getState().snapshots.size).toBe(1);
    expect(useEngineSetupStore.getState().error).toBe('down');
  });

  test('an older refresh resolving after a newer one is dropped', async () => {
    let releaseOlder: () => void = () => undefined;
    const older = useEngineSetupStore.getState().refresh({
      statuses: () => new Promise((resolve) => { releaseOlder = () => resolve([{ ...codex, version: 'old' }]); }),
      readiness: async () => new Map(),
    });
    await useEngineSetupStore.getState().refresh({ statuses: async () => [{ ...codex, version: 'new' }], readiness: async () => new Map() });
    releaseOlder();
    await older;
    expect(useEngineSetupStore.getState().snapshots.get('codex')?.status.version).toBe('new');
  });
});

describe('useEngineSetupStore.login', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubFetch = (handler: (url: string) => Promise<Response>) => {
    globalThis.fetch = ((input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
  };

  test('a network error is stored for that engine and a later success clears it', async () => {
    stubFetch(async () => { throw new Error('offline'); });
    await useEngineSetupStore.getState().login('codex');
    expect(useEngineSetupStore.getState().loginMessage.get('codex')).toBe('offline');

    stubFetch(async () => new Response('{}', { status: 200 }));
    await useEngineSetupStore.getState().login('codex');
    expect(useEngineSetupStore.getState().loginMessage.has('codex')).toBe(false);
  });

  test('concurrent logins for different engines keep each other\'s messages', async () => {
    const releases = new Map<string, () => void>();
    stubFetch((url) => new Promise((resolve) => {
      const engine = url.includes('/codex/') ? 'codex' : 'claude';
      releases.set(engine, () => resolve(new Response(JSON.stringify({ error: `${engine} failed` }), { status: 500 })));
    }));
    const codexLogin = useEngineSetupStore.getState().login('codex');
    const claudeLogin = useEngineSetupStore.getState().login('claude');
    while (releases.size < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.get('codex')?.();
    await codexLogin;
    releases.get('claude')?.();
    await claudeLogin;
    const { loginMessage } = useEngineSetupStore.getState();
    expect(loginMessage.get('codex')).toBe('codex failed');
    expect(loginMessage.get('claude')).toBe('claude failed');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useEngineSetupStore } from './useEngineSetupStore';
import type { EngineStatus } from './engineSetupModel';

const codex: EngineStatus = {
  engine: 'codex', displayName: 'Codex', providerID: 'openai', installed: true, version: '0.162.1',
  latestVersion: null, updateAvailable: false, autoUpdate: { enabled: false, interval: 'daily', lastCheckAt: null, nextCheckAt: null, lastRun: null }, canInstall: true, installCommand: 'npm install -g @openai/codex',
  state: 'idle', lastError: null, installSource: 'npm',
  actions: { install: true, update: true, reinstall: true, uninstall: true, doctor: false },
  commands: { install: 'npm install -g @openai/codex', update: null, reinstall: null, uninstall: null, doctor: 'codex doctor', login: 'codex login --device-auth', logout: null },
  currentAction: null, rawVersion: null, commandPath: null, detectionError: null,
};

beforeEach(() => useEngineSetupStore.setState({
  snapshots: new Map(), loaded: false, error: null, auth: new Map(), actionNotice: new Map(), logoutMessage: new Map(),
}));

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

describe('useEngineSetupStore actions', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: string[] = [];
  const stubFetch = (handler: (url: string, method: string) => Response) => {
    requests.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      return handler(url, method);
    }) as typeof fetch;
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const engineList = (url: string): Response | null => {
    if (url.endsWith('/api/engines')) return json({ data: [codex] });
    if (url.endsWith('/api/engines/readiness')) return json({ data: [{ engine: 'codex', state: 'ready', fixCommand: null }] });
    return null;
  };

  test('a command the server cannot run is kept for that engine, and a started one clears it', async () => {
    stubFetch((url) => engineList(url) ?? json({ error: 'no', command: 'codex doctor' }, 400));
    await useEngineSetupStore.getState().runAction('codex', 'doctor');
    expect(useEngineSetupStore.getState().actionNotice.get('codex')).toEqual({ action: 'doctor', kind: 'command', command: 'codex doctor' });
    expect(useEngineSetupStore.getState().loaded).toBe(true);

    stubFetch((url) => engineList(url) ?? json({ status: 'started' }, 202));
    await useEngineSetupStore.getState().runAction('codex', 'update');
    expect(useEngineSetupStore.getState().actionNotice.has('codex')).toBe(false);
  });

  test('a busy engine is noted as busy', async () => {
    stubFetch((url) => engineList(url) ?? json({ error: 'busy' }, 409));
    await useEngineSetupStore.getState().runAction('codex', 'reinstall');
    expect(useEngineSetupStore.getState().actionNotice.get('codex')).toEqual({ action: 'reinstall', kind: 'busy' });
  });

  test('logout rereads sign-in and the engine list', async () => {
    stubFetch((url, method) => {
      if (method === 'POST') return json({ success: true });
      if (url.endsWith('/auth/status')) return json({ loggedIn: false, email: null });
      return engineList(url) ?? json({}, 404);
    });
    await useEngineSetupStore.getState().logout('codex');
    expect(requests).toContain('POST /api/engines/codex/auth/logout');
    expect(useEngineSetupStore.getState().auth.get('codex')).toEqual({ kind: 'loaded', auth: { loggedIn: false, email: null, method: null, plan: null } });
    expect(useEngineSetupStore.getState().logoutMessage.has('codex')).toBe(false);
  });

  test('a refused logout keeps its message', async () => {
    stubFetch((url, method) => {
      if (method === 'POST') return json({ error: 'Sign out in a terminal' }, 501);
      if (url.endsWith('/auth/status')) return json({ loggedIn: true });
      return engineList(url) ?? json({}, 404);
    });
    await useEngineSetupStore.getState().logout('codex');
    expect(useEngineSetupStore.getState().logoutMessage.get('codex')).toBe('Sign out in a terminal');
  });

  test('a failed sign-in read is recorded per engine', async () => {
    stubFetch(() => json({}, 500));
    await useEngineSetupStore.getState().refreshAuth('claude');
    expect(useEngineSetupStore.getState().auth.get('claude')?.kind).toBe('failed');
  });
});

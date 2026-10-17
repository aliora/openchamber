import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { fetchEngineReadiness, useEngineReadinessStore, type EngineReadinessRead } from './useEngineReadinessStore';

const originalFetch = globalThis.fetch;
const previousResolver = getRuntimeUrlResolver();

// The server's answer once its checks ran: Claude Code ready, Antigravity
// missing, Codex signed out, and an engine not checked yet.
const SERVER_ANSWER = {
  data: [
    { engine: 'claude', providerID: 'anthropic', state: 'ready', fixCommand: null },
    { engine: 'antigravity', providerID: 'google', state: 'not-installed', fixCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    { engine: 'codex', providerID: 'openai', state: 'signed-out', fixCommand: 'codex login' },
    { engine: 'later', providerID: 'later-provider', state: 'unknown', fixCommand: null },
  ],
};

type ServerBody = { data: Array<Record<string, string | null>> } | { error: string };

let requested: string[] = [];
const answerWith = (status: number, body: ServerBody) => {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return Response.json(body, { status });
  }, originalFetch);
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

describe('engine readiness', () => {
  beforeEach(() => {
    requested = [];
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
    useEngineReadinessStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRuntimeUrlResolver(previousResolver);
  });

  test('an engine that is missing or signed out cannot be picked; a ready or unknown one can', async () => {
    answerWith(200, SERVER_ANSWER);

    const read = await fetchEngineReadiness();

    expect(requested).toEqual(['https://runtime.example/api/engines/readiness']);
    expect(read).toEqual({
      unavailable: new Map([
        ['google', { reason: 'not-installed', fixCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' }],
        ['openai', { reason: 'signed-out', fixCommand: 'codex login' }],
      ]),
      // Answers can still change: the server checks the engines that were not ready.
      pending: true,
    });
  });

  test('a state this build does not know greys nothing out, and a malformed entry does not hide the others', async () => {
    answerWith(200, {
      data: [
        { engine: 'claude', providerID: 'anthropic', state: 'updating', fixCommand: null },
        { engine: 'broken' },
        { engine: 'codex', providerID: 'openai', state: 'signed-out', fixCommand: 'codex login' },
      ],
    });

    const read = await fetchEngineReadiness();

    expect(read?.unavailable).toEqual(new Map([['openai', { reason: 'signed-out', fixCommand: 'codex login' }]]));
  });

  test('a signed-out engine without a command, as enterprise mode answers, stays greyed out with no command', async () => {
    answerWith(200, { data: [{ engine: 'codex', providerID: 'openai', state: 'signed-out', fixCommand: null }] });

    const read = await fetchEngineReadiness();

    expect(read?.unavailable).toEqual(new Map([['openai', { reason: 'signed-out', fixCommand: null }]]));
  });

  test('every engine ready leaves nothing to read again', async () => {
    answerWith(200, { data: [{ engine: 'claude', providerID: 'anthropic', state: 'ready', fixCommand: null }] });

    expect(await useEngineReadinessStore.getState().refresh()).toBe(false);
    expect(useEngineReadinessStore.getState().unavailableProviders.size).toBe(0);
    expect(useEngineReadinessStore.getState().loaded).toBe(true);
  });

  test('a runtime without the route greys nothing out', async () => {
    answerWith(404, { error: 'Not found' });

    expect(await fetchEngineReadiness()).toBeNull();
    expect(await useEngineReadinessStore.getState().refresh()).toBe(false);
    expect(useEngineReadinessStore.getState().unavailableProviders.size).toBe(0);
  });

  test('a failed read keeps what the last read knew', async () => {
    answerWith(200, SERVER_ANSWER);
    expect(await useEngineReadinessStore.getState().refresh()).toBe(true);

    answerWith(500, { error: 'boom' });
    await expect(fetchEngineReadiness()).rejects.toThrow('Engine readiness request failed (500)');
    expect(await useEngineReadinessStore.getState().refresh()).toBe(false);

    expect([...useEngineReadinessStore.getState().unavailableProviders.keys()]).toEqual(['google', 'openai']);
  });

  test("an answer still in flight from the previous runtime does not land after a switch", async () => {
    const pending = deferred<EngineReadinessRead | null>();
    const refresh = useEngineReadinessStore.getState().refresh(() => pending.promise);

    useEngineReadinessStore.getState().resetForRuntimeSwitch();
    pending.resolve({ unavailable: new Map([['openai', { reason: 'signed-out', fixCommand: 'codex login' }]]), pending: false });
    await refresh;

    expect(useEngineReadinessStore.getState().unavailableProviders.size).toBe(0);
    expect(useEngineReadinessStore.getState().loaded).toBe(false);
  });
});

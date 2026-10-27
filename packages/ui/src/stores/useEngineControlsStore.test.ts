import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import {
  carriedPermissionMode,
  engineDefaultEffortFor,
  fetchEngineControls,
  isOpenChamberAutoAcceptActive,
  newSessionPermissionMode,
  PermissionModeChangeError,
  permissionModeForTier,
  type EngineControls,
  type PermissionTier,
  useEngineControlsStore,
  type EngineControlsCatalog,
  type EngineControlsTransport,
} from './useEngineControlsStore';

const originalFetch = globalThis.fetch;
const previousResolver = getRuntimeUrlResolver();

const mode = (id: string, extra: { dangerous?: boolean; appliesLive?: boolean } = {}) => ({
  id,
  labelKey: `engine.permissionMode.claude.${id}.label`,
  descriptionKey: `engine.permissionMode.claude.${id}.description`,
  dangerous: extra.dangerous ?? false,
  appliesLive: extra.appliesLive ?? true,
});

// What `GET /api/engines/controls` answers for Claude Code, plus one entry the
// build cannot read.
const SERVER_ANSWER = {
  data: [
    {
      engine: 'claude',
      providerID: 'anthropic',
      defaultPermissionMode: 'auto',
      permissionModes: [mode('manual'), mode('auto'), mode('bypassPermissions', { dangerous: true, appliesLive: false })],
      defaultEffort: 'medium',
    },
    { engine: 'broken', providerID: 'broken', defaultPermissionMode: 'missing', permissionModes: [], defaultEffort: null },
  ],
  default: 'claude',
};

type Request = { url: string; method: string; body: string | null };
let requests: Request[] = [];
const answerWith = (answer: (request: Request) => Response) => {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const entry = { url: request.url, method: request.method, body: request.method === 'GET' ? null : await request.text() };
    requests.push(entry);
    return answer(entry);
  }, originalFetch);
};

const CATALOG: EngineControlsCatalog = {
  engines: [{
    engine: 'claude',
    providerID: 'anthropic',
    defaultPermissionMode: 'auto',
    permissionModes: [mode('manual'), mode('acceptEdits'), mode('auto')],
    defaultEffort: 'medium',
  }],
  defaultEngine: 'claude',
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
};

const transport = (overrides: Partial<EngineControlsTransport>): EngineControlsTransport => ({
  fetchControls: async () => CATALOG,
  fetchSession: async () => ({ engine: 'claude', permissionMode: 'auto' }),
  patchPermissionMode: async () => {},
  ...overrides,
});

describe('engine controls', () => {
  beforeEach(() => {
    requests = [];
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
    useEngineControlsStore.getState().resetForRuntimeSwitch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRuntimeUrlResolver(previousResolver);
  });

  test('reads each engine permission modes and drops an engine it cannot read', async () => {
    answerWith(() => Response.json(SERVER_ANSWER));
    const catalog = await fetchEngineControls();
    expect(requests.map((request) => request.url)).toEqual(['https://runtime.example/api/engines/controls']);
    expect(catalog?.defaultEngine).toBe('claude');
    expect(catalog?.engines.map((engine) => engine.engine)).toEqual(['claude']);
    expect(catalog?.engines[0]?.permissionModes.map((entry) => [entry.id, entry.dangerous, entry.appliesLive])).toEqual([
      ['manual', false, true],
      ['auto', false, true],
      ['bypassPermissions', true, false],
    ]);
  });

  test('tells a server without engines from a failed read', async () => {
    answerWith(() => Response.json({ error: 'not found' }, { status: 404 }));
    await useEngineControlsStore.getState().load();
    expect(useEngineControlsStore.getState().status).toBe('unsupported');
    // Only there does OpenChamber's own auto-accept still apply.
    expect(isOpenChamberAutoAcceptActive()).toBe(true);

    useEngineControlsStore.getState().resetForRuntimeSwitch();
    answerWith(() => Response.json({ error: 'down' }, { status: 502 }));
    await useEngineControlsStore.getState().load();
    expect(useEngineControlsStore.getState().status).toBe('failed');
    expect(isOpenChamberAutoAcceptActive()).toBe(false);

    answerWith(() => Response.json(SERVER_ANSWER));
    await useEngineControlsStore.getState().load();
    expect(useEngineControlsStore.getState().status).toBe('ready');
    expect(isOpenChamberAutoAcceptActive()).toBe(false);
  });

  test('reads a session engine and mode, with defaults for a record from before engines', async () => {
    const store = useEngineControlsStore.getState();
    await store.load(transport({}));
    answerWith((request) => Response.json(request.url.endsWith('/old') ? { id: 'old' } : { id: 'new', engine: 'claude', permissionMode: 'manual' }));
    await store.loadSession('new');
    await store.loadSession('old');
    expect(requests.map((request) => request.url)).toEqual([
      'https://runtime.example/api/sessions/new',
      'https://runtime.example/api/sessions/old',
    ]);
    expect(useEngineControlsStore.getState().sessions.get('new')).toEqual({ engine: 'claude', permissionMode: 'manual' });
    expect(useEngineControlsStore.getState().sessions.get('old')).toEqual({ engine: 'claude', permissionMode: 'auto' });
  });

  test('stores a picked mode on the session with one PATCH', async () => {
    const store = useEngineControlsStore.getState();
    await store.load(transport({}));
    await store.loadSession('ses_1', transport({}));
    answerWith(() => new Response(null, { status: 204 }));

    await store.setSessionPermissionMode('ses_1', 'manual');

    expect(requests).toEqual([{ url: 'https://runtime.example/api/session/ses_1', method: 'PATCH', body: JSON.stringify({ permissionMode: 'manual' }) }]);
    expect(useEngineControlsStore.getState().sessions.get('ses_1')?.permissionMode).toBe('manual');
  });

  test('puts the previous mode back when the server refuses, with its reason', async () => {
    const store = useEngineControlsStore.getState();
    await store.load(transport({}));
    await store.loadSession('ses_1', transport({}));
    answerWith(() => Response.json({ _tag: 'InvalidRequestError', message: 'Unknown permission mode for Claude Code: ask', field: 'permissionMode' }, { status: 400 }));

    const change = store.setSessionPermissionMode('ses_1', 'ask');
    expect(useEngineControlsStore.getState().sessions.get('ses_1')?.permissionMode).toBe('ask');
    const error = await change.catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(PermissionModeChangeError);
    expect(error instanceof PermissionModeChangeError ? error.reason : null).toBe('Unknown permission mode for Claude Code: ask');
    expect(useEngineControlsStore.getState().sessions.get('ses_1')?.permissionMode).toBe('auto');
  });

  test('keeps a newer pick when an older one fails, and a pick over a read that started before it', async () => {
    const store = useEngineControlsStore.getState();
    await store.load(transport({}));
    await store.loadSession('ses_1', transport({}));
    const first = deferred();
    const firstChange = store.setSessionPermissionMode('ses_1', 'manual', transport({ patchPermissionMode: () => first.promise }));
    await store.setSessionPermissionMode('ses_1', 'acceptEdits', transport({}));
    first.reject(new Error('offline'));
    await firstChange.catch(() => undefined);
    expect(useEngineControlsStore.getState().sessions.get('ses_1')?.permissionMode).toBe('acceptEdits');

    // A read that left before a pick does not undo it.
    let answerRead!: () => void;
    const read = store.loadSession('ses_1', transport({
      fetchSession: () => new Promise((resolve) => { answerRead = () => resolve({ engine: 'claude', permissionMode: 'auto' }); }),
    }));
    await store.setSessionPermissionMode('ses_1', 'manual', transport({}));
    answerRead();
    await read;
    expect(useEngineControlsStore.getState().sessions.get('ses_1')?.permissionMode).toBe('manual');
  });

  test('drops answers that arrive after a runtime switch', async () => {
    let answerControls!: (catalog: EngineControlsCatalog) => void;
    const load = useEngineControlsStore.getState().load(transport({
      fetchControls: () => new Promise((resolve) => { answerControls = resolve; }),
    }));
    useEngineControlsStore.getState().resetForRuntimeSwitch();
    answerControls(CATALOG);
    await load;
    expect(useEngineControlsStore.getState()).toMatchObject({ status: 'idle', catalog: null });
  });

  test('names the engine default effort only when the model offers it', () => {
    expect(engineDefaultEffortFor(CATALOG, 'anthropic', ['low', 'medium', 'high'])).toBe('medium');
    expect(engineDefaultEffortFor(CATALOG, 'anthropic', ['low', 'high'])).toBeNull();
    expect(engineDefaultEffortFor(CATALOG, 'openai', ['low', 'medium'])).toBeNull();
    expect(engineDefaultEffortFor(null, 'anthropic', ['medium'])).toBeNull();
  });
});

describe('permission ladder', () => {
  const tiered = (id: string, tier: PermissionTier) => ({ ...mode(id, { dangerous: tier === 'full' }), tier });
  const claude: EngineControls = {
    engine: 'claude',
    providerID: 'anthropic',
    defaultPermissionMode: 'auto',
    permissionModes: [tiered('plan', 'read'), tiered('manual', 'ask'), tiered('acceptEdits', 'edits'), tiered('auto', 'auto'), tiered('bypassPermissions', 'full')],
    defaultEffort: null,
  };
  const codex: EngineControls = {
    engine: 'codex',
    providerID: 'openai',
    defaultPermissionMode: 'on-request',
    permissionModes: [tiered('read-only', 'read'), tiered('untrusted', 'ask'), tiered('on-request', 'auto'), tiered('full-access', 'full')],
    defaultEffort: null,
  };
  const catalog: EngineControlsCatalog = { engines: [claude, codex], defaultEngine: 'claude' };

  test('a rung maps to the mode on it, else the nearest below', () => {
    expect(permissionModeForTier(codex, 'full')).toBe('full-access');
    expect(permissionModeForTier(codex, 'edits')).toBe('untrusted');
    expect(permissionModeForTier(claude, 'read')).toBe('plan');
    expect(permissionModeForTier({ ...codex, permissionModes: [tiered('on-request', 'auto')] }, 'ask')).toBeNull();
  });

  test('full permission stays full and lower picks keep their rung across engines', () => {
    expect(carriedPermissionMode(catalog, { engine: 'claude', mode: 'bypassPermissions' }, codex)).toBe('full-access');
    expect(carriedPermissionMode(catalog, { engine: 'codex', mode: 'full-access' }, claude)).toBe('bypassPermissions');
    expect(carriedPermissionMode(catalog, { engine: 'claude', mode: 'plan' }, codex)).toBe('read-only');
    expect(carriedPermissionMode(catalog, { engine: 'claude', mode: 'manual' }, codex)).toBe('untrusted');
    expect(carriedPermissionMode(catalog, { engine: 'claude', mode: 'auto' }, codex)).toBe('on-request');
    expect(carriedPermissionMode(catalog, { engine: 'claude', mode: 'gone' }, codex)).toBe('on-request');
  });

  test('a new session takes the draft pick, else the remembered rung, else the engine default', () => {
    expect(newSessionPermissionMode(catalog, { engine: 'claude', mode: 'manual' }, 'full', codex)).toBe('untrusted');
    expect(newSessionPermissionMode(catalog, undefined, 'full', codex)).toBe('full-access');
    expect(newSessionPermissionMode(catalog, undefined, 'full', claude)).toBe('bypassPermissions');
    expect(newSessionPermissionMode(catalog, undefined, undefined, codex)).toBe('on-request');
  });
});

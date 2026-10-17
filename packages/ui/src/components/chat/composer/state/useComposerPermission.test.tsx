import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import type { EngineControls, EngineControlsCatalog } from '@/stores/useEngineControlsStore';
import type { ComposerPermission } from './useComposerPermission';

const installDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  };
};

const mode = (engine: string, id: string, dangerous = false) => ({
  id,
  labelKey: `engine.permissionMode.${engine}.${id}.label`,
  descriptionKey: `engine.permissionMode.${engine}.${id}.description`,
  dangerous,
  appliesLive: engine === 'claude' && !dangerous,
});
const CLAUDE: EngineControls = {
  engine: 'claude',
  providerID: 'anthropic',
  defaultPermissionMode: 'auto',
  permissionModes: [mode('claude', 'manual'), mode('claude', 'acceptEdits'), mode('claude', 'auto'), mode('claude', 'bypassPermissions', true)],
  defaultEffort: 'medium',
};
const CODEX: EngineControls = {
  engine: 'codex',
  providerID: 'openai',
  defaultPermissionMode: 'on-request',
  permissionModes: [mode('codex', 'read-only'), mode('codex', 'on-request'), mode('codex', 'never')],
  defaultEffort: 'medium',
};
const CATALOG: EngineControlsCatalog = { engines: [CLAUDE, CODEX], defaultEngine: 'claude' };

const originalFetch = globalThis.fetch;
const previousResolver = getRuntimeUrlResolver();
type Request = { url: string; method: string; body: string | null };
let requests: Request[] = [];
let storedMode = 'acceptEdits';

let restoreDom: () => Promise<void>;
let root: { render: (node: React.ReactNode) => void; unmount: () => void };
let latest: ComposerPermission = { kind: 'pending' };

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(async () => {
  restoreDom = installDom();
  requests = [];
  storedMode = 'acceptEdits';
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
  // The server: the session's stored record, and the PATCH that changes it.
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = request.method === 'GET' ? null : await request.text();
    requests.push({ url: request.url, method: request.method, body });
    if (request.method === 'PATCH') return new Response(null, { status: 204 });
    if (request.url.includes('/api/sessions/')) return Response.json({ id: 'ses_1', engine: 'claude', permissionMode: storedMode });
    // Stores the session UI store brings along read their own routes; they find nothing here.
    if (request.url.includes('/api/session?')) return Response.json({ data: [], cursor: { previous: null, next: null } });
    return Response.json({ error: 'not found' }, { status: 404 });
  }, originalFetch);
  const { useEngineControlsStore } = await import('@/stores/useEngineControlsStore');
  useEngineControlsStore.getState().resetForRuntimeSwitch();
  useEngineControlsStore.setState({ status: 'ready', catalog: CATALOG });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(previousResolver);
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  useSessionUIStore.getState().closeNewSessionDraft();
  await restoreDom();
});

const renderHook = async (args: { sessionId: string | null; draftOpen: boolean; providerId: string | null }) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { useComposerPermission } = await import('./useComposerPermission');
  const Probe = () => {
    latest = useComposerPermission(args);
    return null;
  };
  await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
  await flush();
};

const engineState = () => {
  if (latest.kind !== 'engine') throw new Error(`Expected engine controls, got ${latest.kind}`);
  return latest;
};

describe('composer permission', () => {
  test('a draft lists the modes of the picked model engine and keeps its pick for that engine', async () => {
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    useSessionUIStore.setState({ newSessionDraft: { draftId: 1, open: true, directoryOverride: null, parentID: null, target: 'chat' } });

    await renderHook({ sessionId: null, draftOpen: true, providerId: 'anthropic' });
    expect(engineState().engine.engine).toBe('claude');
    expect(engineState().mode.id).toBe('auto');

    await act(async () => engineState().select('manual'));
    expect(useSessionUIStore.getState().newSessionDraft.enginePermissionMode).toEqual({ engine: 'claude', mode: 'manual' });
    expect(engineState().mode.id).toBe('manual');
    // Nothing goes to the server before the session exists.
    expect(requests.filter((request) => request.method === 'PATCH' || request.url.includes('/api/sessions/'))).toEqual([]);

    // Another engine's model shows that engine's modes from its default.
    await renderHook({ sessionId: null, draftOpen: true, providerId: 'openai' });
    expect(engineState().engine.permissionModes.map((entry) => entry.id)).toEqual(['read-only', 'on-request', 'never']);
    expect(engineState().mode.id).toBe('on-request');
  });

  test('a session shows its stored mode and stores a pick on the server', async () => {
    await renderHook({ sessionId: 'ses_1', draftOpen: false, providerId: 'anthropic' });
    expect(requests).toEqual([{ url: 'https://runtime.example/api/sessions/ses_1', method: 'GET', body: null }]);
    expect(engineState().mode.id).toBe('acceptEdits');

    await act(async () => engineState().select('manual'));
    await flush();
    expect(requests.at(-1)).toEqual({ url: 'https://runtime.example/api/session/ses_1', method: 'PATCH', body: JSON.stringify({ permissionMode: 'manual' }) });
    expect(engineState().mode.id).toBe('manual');
  });

  test('a server without engines keeps the shield', async () => {
    const { useEngineControlsStore } = await import('@/stores/useEngineControlsStore');
    useEngineControlsStore.setState({ status: 'unsupported', catalog: null });
    await renderHook({ sessionId: 'ses_1', draftOpen: false, providerId: 'anthropic' });
    expect(latest.kind).toBe('shield');
    expect(requests).toEqual([]);
  });

  test('the permission shortcut steps through the safe modes only', async () => {
    const { nextCycledPermissionMode } = await import('./useComposerPermission');
    expect(nextCycledPermissionMode(CLAUDE, 'manual')).toBe('acceptEdits');
    expect(nextCycledPermissionMode(CLAUDE, 'auto')).toBe('manual');
    // From bypass, picked by hand, the next safe mode is the first one.
    expect(nextCycledPermissionMode(CLAUDE, 'bypassPermissions')).toBe('manual');
    expect(nextCycledPermissionMode(CODEX, 'never')).toBe('read-only');
  });
});

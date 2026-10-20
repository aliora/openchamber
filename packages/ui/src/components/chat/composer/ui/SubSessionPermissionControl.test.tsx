import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import type { EngineControls } from '@/stores/useEngineControlsStore';

const installDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
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

const mode = (id: string) => ({
  id,
  labelKey: `engine.permissionMode.claude.${id}.label`,
  descriptionKey: `engine.permissionMode.claude.${id}.description`,
  dangerous: false,
  appliesLive: true,
});
const CLAUDE: EngineControls = {
  engine: 'claude',
  providerID: 'anthropic',
  defaultPermissionMode: 'auto',
  permissionModes: [mode('manual'), mode('acceptEdits'), mode('auto')],
  defaultEffort: 'medium',
};

const originalFetch = globalThis.fetch;
const previousResolver = getRuntimeUrlResolver();
type Request = { url: string; method: string; body: string | null };
let requests: Request[] = [];

let restoreDom: () => Promise<void>;
let root: { render: (node: React.ReactNode) => void; unmount: () => void };
let container: HTMLElement;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(async () => {
  restoreDom = installDom();
  requests = [];
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = request.method === 'GET' ? null : await request.text();
    requests.push({ url: request.url, method: request.method, body });
    if (request.method === 'PATCH') return new Response(null, { status: 204 });
    if (request.url.endsWith('/api/sessions/ses_child')) return Response.json({ id: 'ses_child', engine: 'claude', permissionMode: 'acceptEdits' });
    return Response.json({ error: 'not found' }, { status: 404 });
  }, originalFetch);
  await import('@/lib/hosts/runtime/app-host');
  const { useEngineControlsStore } = await import('@/stores/useEngineControlsStore');
  useEngineControlsStore.getState().resetForRuntimeSwitch();
  useEngineControlsStore.setState({ status: 'ready', catalog: { engines: [CLAUDE], defaultEngine: 'claude' } });
  const { createRoot } = await import('react-dom/client');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(previousResolver);
  await restoreDom();
});

const render = async (isMobile: boolean) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { SubSessionPermissionControl } = await import('./SubSessionPermissionControl');
  await act(async () => root.render(<I18nProvider><SubSessionPermissionControl sessionId="ses_child" isMobile={isMobile} /></I18nProvider>));
  await flush();
};

const trigger = () => {
  const element = container.querySelector<HTMLButtonElement>('[data-testid="composer-permission-control"]');
  if (!element) throw new Error('Missing permission control');
  return element;
};

describe('sub-session permission control', () => {
  test('shows the sub-session mode and stores a pick on that sub-session only', async () => {
    await render(false);
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Auto-accept edits');

    await act(async () => { trigger().click(); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    await act(async () => { items[0]?.click(); });
    await flush();

    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([
      { url: 'https://runtime.example/api/session/ses_child', method: 'PATCH', body: JSON.stringify({ permissionMode: 'manual' }) },
    ]);
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Ask before changes');
  });

  test('keeps only the icon on mobile and names the mode for assistive tech', async () => {
    await render(true);
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Auto-accept edits');
    expect(trigger().querySelector('.composer-footer__control-label')?.classList.contains('hidden')).toBe(true);
  });

  test('renders nothing on a server without engines', async () => {
    const { useEngineControlsStore } = await import('@/stores/useEngineControlsStore');
    useEngineControlsStore.setState({ status: 'unsupported', catalog: null });
    await render(false);
    expect(container.querySelector('[data-testid="composer-permission-control"]')).toBeNull();
    expect(requests).toEqual([]);
  });
});

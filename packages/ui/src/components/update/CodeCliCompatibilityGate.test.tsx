import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { CodeCliCompatibilityGate } from './CodeCliCompatibilityGate';
import { prefetchCodeCliCompatibility } from './codeCliCompatibilityCheck';
import { useUIStore } from '@/stores/useUIStore';

let root: Root;
let host: HTMLDivElement;
let restoreGlobals: () => void;
let mounts: number;
let requests: string[];
let respond: () => Promise<Response>;

const version = (value: string, canInstall = false) => Response.json({
  state: value.startsWith('2.') ? 'compatible' : 'incompatible',
  version: value,
  installation: 'managed',
  canInstall,
});

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond();
    },
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  restoreGlobals = () => {
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounts = 0;
  requests = [];
  respond = async () => version('1.18.30');
  useUIStore.getState().setEngineSetupOpen(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
});

function Application() {
  React.useEffect(() => { mounts += 1; }, []);
  return <main>Application mounted</main>;
}

const render = () => act(async () => {
  root.render(<I18nProvider><CodeCliCompatibilityGate><Application /></CodeCliCompatibilityGate></I18nProvider>);
});

const wizardOpen = () => useUIStore.getState().isEngineSetupOpen;

const REMOTE_SWITCH = { apiBaseUrl: 'https://remote.example', previousApiBaseUrl: '', runtimeKey: 'url:https://remote.example', previousRuntimeKey: 'local' };

test('a server without any engine CLI opens the setup wizard and keeps the application mounted', async () => {
  await render();
  expect(mounts).toBe(1);
  expect(host.textContent).toContain('Application mounted');
  expect(wizardOpen()).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/api/codecli/compatibility');
});

test('a server with an installed engine leaves the setup wizard closed', async () => {
  respond = async () => version('2.0.14');
  await render();
  expect(host.textContent).toContain('Application mounted');
  expect(wizardOpen()).toBe(false);
});

test('the application mounts while the check runs and stays mounted', async () => {
  let complete: (response: Response) => void = () => { throw new Error('Missing request'); };
  respond = () => new Promise<Response>((resolve) => { complete = resolve; });
  await render();
  expect(mounts).toBe(1);
  await act(async () => complete(version('1.18.30')));
  expect(mounts).toBe(1);
  expect(host.textContent).toContain('Application mounted');
});

test('a check prefetched at page load answers the gate without a second request', async () => {
  prefetchCodeCliCompatibility();
  await render();
  expect(requests).toHaveLength(1);
  expect(wizardOpen()).toBe(true);
});

test('a prefetched check that failed before sign-in is asked again when the gate mounts', async () => {
  respond = async () => requests.length === 1 ? new Response(null, { status: 401 }) : version('1.18.30');
  prefetchCodeCliCompatibility();
  await render();
  expect(requests.filter((url) => url.includes('/api/codecli/compatibility'))).toHaveLength(2);
  expect(wizardOpen()).toBe(true);
});

test('turning the gate on checks the new server without remounting the application', async () => {
  respond = async () => version('2.0.14');
  const renderWith = (enabled: boolean) => act(async () => {
    root.render(<I18nProvider><CodeCliCompatibilityGate enabled={enabled}><Application /></CodeCliCompatibilityGate></I18nProvider>);
  });
  await renderWith(false);
  expect(requests).toHaveLength(0);
  await renderWith(true);
  expect(requests).toHaveLength(1);
  await renderWith(false);
  await renderWith(true);
  expect(requests).toHaveLength(2);
  expect(mounts).toBe(1);
  expect(host.textContent).toContain('Application mounted');
});

test('an unavailable compatibility endpoint leaves the existing connection recovery in charge', async () => {
  respond = async () => new Response(null, { status: 503 });
  await render();
  expect(mounts).toBe(1);
  expect(wizardOpen()).toBe(false);
});

test('a stale result from the previous runtime cannot open the setup wizard', async () => {
  const replies: Array<(response: Response) => void> = [];
  respond = () => new Promise<Response>((resolve) => { replies.push(resolve); });
  await render();
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed', { detail: REMOTE_SWITCH }));
  });
  expect(replies).toHaveLength(2);
  await act(async () => replies[0](version('1.18.30')));
  expect(wizardOpen()).toBe(false);
  await act(async () => replies[1](version('2.0.14')));
  expect(wizardOpen()).toBe(false);
  expect(host.textContent).toContain('Application mounted');
});

// The readiness probe is one desktop command among others (the i18n provider
// also syncs the menu locale on mount), so only that command reaches `probe`.
const desktopReadiness = (probe: () => Promise<boolean>) => {
  const invoke = (command: string) => (command === 'desktop_managed_opencode_compatible' ? probe() : Promise.resolve(undefined));
  Object.defineProperties(window, {
    __OPENCHAMBER_ELECTRON__: { configurable: true, value: { runtime: 'electron' } },
    __OPENCHAMBER_LOCAL_ORIGIN__: { configurable: true, value: 'http://127.0.0.1:3901' },
    __OPENCHAMBER_API_BASE_URL__: { configurable: true, writable: true, value: 'http://127.0.0.1:3901' },
    __OPENCHAMBER_DESKTOP__: { configurable: true, value: { invoke } },
  });
};

test('ready managed desktop starts bootstrap without a compatibility HTTP request', async () => {
  let probes = 0;
  desktopReadiness(async () => { probes += 1; return true; });
  await render();
  expect(probes).toBe(1);
  expect(requests).toHaveLength(0);
  expect(mounts).toBe(1);
});

test('unconfirmed desktop readiness keeps the authoritative compatibility check', async () => {
  desktopReadiness(async () => false);
  await render();
  expect(requests).toHaveLength(1);
  expect(wizardOpen()).toBe(true);
});

test('a failed native readiness read falls back to the compatibility endpoint', async () => {
  desktopReadiness(async () => { throw new Error('Older desktop host'); });
  await render();
  expect(requests).toHaveLength(1);
  expect(host.textContent).toContain('Application mounted');
});

test('switching to a remote runtime cannot reuse an in-flight local readiness verdict', async () => {
  let complete: (ready: boolean) => void = () => { throw new Error('Missing IPC'); };
  desktopReadiness(() => new Promise<boolean>(resolve => { complete = resolve; }));
  await render();
  expect(mounts).toBe(1);
  Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://remote.example' });
  await act(async () => window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed', { detail: REMOTE_SWITCH })));
  await act(async () => complete(true));
  expect(requests).toHaveLength(1);
  expect(wizardOpen()).toBe(true);
});

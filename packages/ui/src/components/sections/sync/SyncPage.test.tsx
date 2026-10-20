import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';

import { Window } from 'happy-dom';
import React, { act } from 'react';

import type { HostOption } from '@/components/sections/shared/useHostOptions';
import type { PortableValue } from '@/lib/settings/portable-settings';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { SyncPageView } = await import('./SyncPage');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const SECRET = 'Bearer secret-token-123';
const json = (body: PortableValue) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const mcpItem = (fingerprint: string) => ({ key: 'github', label: 'github', detail: 'remote', fingerprint, updatedAt: null, paths: [] });
const projectItem = { key: '~/work/app', label: 'App', detail: '~/work/app', fingerprint: 'p', updatedAt: null, paths: ['~/work/app'] };

const sent: { host: string; path: string; body: string }[] = [];

const hostOption = (id: string, label: string, handler: (path: string, body: string) => Response, reachable = true, focused = false): HostOption => ({
  id,
  label,
  reachable,
  focused,
  request: async (path, init) => {
    const body = String(init?.body ?? '');
    sent.push({ host: id, path, body });
    return handler(path, body);
  },
});

const macHost = hostOption('local', 'Mac', (path, body) => {
  if (path === '/api/portable-settings') {
    return json({ categories: { mcp: { status: 'ok', items: [mcpItem('a')] }, projects: { status: 'ok', items: [projectItem] } } });
  }
  const refs: { category: string; key: string }[] = JSON.parse(body).items;
  const valueOf = (category: string): PortableValue => (category === 'mcp' ? { type: 'remote', headers: { Authorization: SECRET } } : { label: 'App' });
  return json({ items: refs.map((ref) => ({ ...ref, status: 'found', value: valueOf(ref.category), updatedAt: null })) });
}, true, true);

const piHost = hostOption('host:pi', 'Pi 5', (path, body) => {
  if (path === '/api/portable-settings' && !body) return json({ categories: { mcp: { status: 'ok', items: [mcpItem('b')] }, projects: { status: 'ok', items: [] } } });
  return json({
    results: [
      { category: 'mcp', key: 'github', status: 'applied' },
      { category: 'projects', key: '~/work/app', status: 'refused', reason: 'path-missing', path: '~/work/app' },
    ],
  });
});

const msiHost = hostOption('host:msi', 'MSI', () => json({}), false);

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const render = async (hosts: HostOption[]) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><SyncPageView hosts={hosts} /></I18nProvider>);
  });
  await settle();
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
};

const clickButton = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
  if (!button) throw new Error(`No button ${label}`);
  await act(async () => button.click());
  await settle();
};

test('lists what differs per host, copies the chosen items, reports a missing folder and never shows or logs a secret', async () => {
  sent.length = 0;
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  }));
  const container = await render([macHost, piHost, msiHost]);

  const text = () => container.textContent ?? '';
  expect(text()).toContain('MCP servers');
  expect(text()).toContain('github');
  expect(text()).toContain('Version A');
  expect(text()).toContain('Version B');
  expect(text()).toContain('Missing');
  expect(text()).toContain('Not connected');
  expect(sent.some((request) => request.host === 'host:msi')).toBe(false);

  const selectAll = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent?.includes('Select all'));
  if (!selectAll) throw new Error('No select all');
  await act(async () => selectAll.click());
  await clickButton(container, 'Copy 2 items');

  const imported = sent.find((request) => request.host === 'host:pi' && request.path === '/api/portable-settings' && request.body);
  expect(JSON.parse(imported?.body ?? '{}').force).toBe(true);
  expect(text()).toContain('No folder ~/work/app here');
  expect(text()).not.toContain('secret-token-123');
  expect(container.innerHTML).not.toContain('secret-token-123');
  expect(logged.join('\n')).not.toContain('secret-token-123');
  for (const spy of spies) spy.mockRestore();
});

test('a single reachable host shows that there is nothing to compare', async () => {
  const container = await render([macHost, msiHost]);
  expect(container.textContent).toContain('Only one server is connected');
});

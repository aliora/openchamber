import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

const dom = new Window({ url: 'http://localhost', width: 1024, height: 768 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ErrorBoundary } = await import('./ErrorBoundary');

afterAll(() => {
  void dom.happyDOM.abort();
});

const Content: React.FC<{ fail: boolean }> = ({ fail }) => {
  if (fail) throw new Error('broken');
  return <p data-content="">content</p>;
};

test('a boundary keeps its children across reset key changes and clears a caught error when the key changes', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = (resetKey: string, fail: boolean) => root.render(
    <I18nProvider><ErrorBoundary resetKey={resetKey} fallback={<p data-fallback="" />}><Content fail={fail} /></ErrorBoundary></I18nProvider>,
  );

  await act(async () => show('a', false));
  const content = container.querySelector('[data-content]');
  await act(async () => show('b', false));
  expect(container.querySelector('[data-content]')).toBe(content);

  await act(async () => show('b', true));
  expect(container.querySelector('[data-fallback]')).not.toBeNull();
  await act(async () => show('b', false));
  expect(container.querySelector('[data-fallback]')).not.toBeNull();

  await act(async () => show('c', false));
  expect(container.querySelector('[data-fallback]')).toBeNull();
  expect(container.querySelector('[data-content]')).not.toBeNull();

  await act(async () => root.unmount());
  consoleError.mockRestore();
});

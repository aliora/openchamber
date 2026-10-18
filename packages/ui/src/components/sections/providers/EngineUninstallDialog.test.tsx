import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { EngineUninstallDialog } = await import('./EngineUninstallDialog');

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

const render = async (onConfirm: (removeConfig: boolean) => void) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <EngineUninstallDialog engineName="Codex" onCancel={() => undefined} onConfirm={onConfirm} />
      </I18nProvider>,
    );
  });
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
};

const button = (label: string): HTMLElement => {
  const match = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`No button ${label}`);
  return match as unknown as HTMLElement;
};

test('uninstall keeps the config unless the box is ticked', async () => {
  const choices: boolean[] = [];
  await render((removeConfig) => choices.push(removeConfig));
  expect(document.body.textContent).toContain('Uninstall Codex?');
  await act(async () => { button('Uninstall').click(); });
  const checkbox = document.querySelector('[role="button"][aria-pressed]') as unknown as HTMLElement;
  expect(checkbox.getAttribute('aria-pressed')).toBe('false');
  await act(async () => { checkbox.click(); });
  await act(async () => { button('Uninstall').click(); });
  expect(choices).toEqual([false, true]);
});

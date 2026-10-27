import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { useSessionSearchEffects } = await import('./useSessionSearchEffects');

const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);

afterAll(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function Harness({ onClose }: { onClose: () => void }): React.ReactNode {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  useSessionSearchEffects({
    isSessionSearchOpen: true,
    openSessionSearch: () => undefined,
    closeSessionSearch: onClose,
    sessionSearchInputRef: inputRef,
    sessionSearchContainerRef: containerRef,
  });
  return (
    <>
      <div ref={containerRef}><input ref={inputRef} /></div>
      <div role="menu"><button type="button" id="menu-item">Running</button></div>
      <button type="button" id="outside">Elsewhere</button>
    </>
  );
}

const pressOn = (id: string) => {
  document.getElementById(id)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};

describe('useSessionSearchEffects', () => {
  test('a choice in a menu keeps the search, a click elsewhere closes it', async () => {
    let closed = 0;
    await act(async () => root.render(<Harness onClose={() => { closed += 1; }} />));
    pressOn('menu-item');
    expect(closed).toBe(0);
    pressOn('outside');
    expect(closed).toBe(1);
  });
});

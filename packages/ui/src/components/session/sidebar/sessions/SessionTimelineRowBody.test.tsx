import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const title = 'درخواست پاسخ فارسی با React';

const project = { id: 'project-a', icon: null, color: null, iconImage: null, iconBackground: null };

const renderRow = (compact: boolean, withProject = false) => root.render(<SessionTimelineRowBody
  compact={compact}
  project={withProject ? project : null}
  projectLabel={withProject ? 'openchamber' : null}
  title={title}
  titleClassName=""
  statusDot={null}
  directoryIndicator={null}
  zombieIndicator={null}
  hideMetaOnHoverClass=""
/>);

// A truncated title in an LTR box clips an RTL title's beginning, because its
// first word sits at the right edge. dir=auto lets the title own its direction.
for (const [compact, withProject] of [[true, false], [false, false], [false, true]] as const) {
  test(`the title resolves its own direction (compact: ${compact}, project: ${withProject})`, async () => {
    await act(async () => renderRow(compact, withProject));
    // The innermost box holding the title is the one that truncates it.
    const element = Array.from(document.querySelectorAll('div')).reverse().find((node) => node.textContent === title);
    expect(element?.getAttribute('dir')).toBe('auto');
  });
}

test('a two-line row keeps the title alone on its line and puts state and project on the second, without a branch', async () => {
  await act(async () => root.render(<SessionTimelineRowBody
    project={{ id: 'project-a' }}
    projectLabel="demo-app"
    title="Fix login"
    titleClassName=""
    statusDot={<span data-testid="mark" />}
    statusLabel="Running"
    directoryIndicator={null}
    zombieIndicator={null}
      hideMetaOnHoverClass=""
  />));
  const [titleLine, stateLine] = Array.from(document.querySelectorAll<HTMLElement>('.h-5, .h-4'));
  expect(titleLine?.textContent).toBe('Fix login');
  expect(stateLine?.textContent).toBe('Running·demo-app');
  expect(document.querySelector('use[href="#oc-git-branch"]')).toBeNull();
  expect(stateLine?.querySelector('[data-testid="mark"]')).not.toBeNull();
});

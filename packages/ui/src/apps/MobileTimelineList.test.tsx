import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { Session } from '@/lib/opencode/model';

mock.module('@/components/session/useSessionAiRenameAction', () => ({
  useSessionAiRenameAction: () => ({ pending: false, disabled: true, disabledReason: null, run: () => {} }),
}));

test('timeline rows carry no branch: under a project header one line, where projects mix the project on the second', async () => {
  const dom = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { MobileTimelineRows } = await import('./MobileTimelineList');

  const session = { id: 'ses_a', title: 'Fix login', directory: '/work/api', time: { created: 1, updated: 1 } } as Session;
  const project = { id: 'api', label: 'api-server', path: '/work/api' };
  const handlers = {
    currentSessionId: null, revealedSessionId: null, confirmingDeleteSessionId: null, renamingSessionId: null,
    onSelect: () => {}, onRevealedChange: () => {}, onArchive: () => {}, onRequestDelete: () => {}, onConfirmDelete: () => {},
    onRequestRename: () => {}, onSubmitRename: () => {}, onCancelRename: () => {},
    isPinned: () => false, onTogglePin: () => {}, descendantIdsOf: () => [],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (showProject: boolean) => act(async () => {
    root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <MobileTimelineRows entries={[{ kind: 'session', session, project }]} showProject={showProject} handlers={handlers} />
        </I18nProvider>
      </ThemeSystemProvider>,
    );
  });

  await render(false);
  expect(container.textContent).toContain('Fix login');
  expect(container.textContent).not.toContain('api-server');
  expect(container.querySelector('use[href="#oc-git-branch"]')).toBeNull();
  expect(container.querySelector('.h-4')).toBeNull();

  await render(true);
  expect(container.querySelector('.h-4')?.textContent).toContain('api-server');
  expect(container.querySelector('use[href="#oc-git-branch"]')).toBeNull();
  await act(async () => root.unmount());
});

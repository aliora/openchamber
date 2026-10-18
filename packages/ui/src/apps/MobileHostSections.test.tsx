import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import type { HostOpenRequest } from '@/lib/hosts/open-host-session';
import type { HostConnection, HostDescriptor, HostProject, HostSessionSummary } from '@/lib/hosts/types';

const openRequests: HostOpenRequest[] = [];
mock.module('./mobileHostSessionOpener', () => ({
  mobileHostSessionOpener: {
    open: async (request: HostOpenRequest) => {
      openRequests.push(request);
      return 'pending';
    },
  },
}));

const descriptor = (id: string, label: string): HostDescriptor => ({
  id, label, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true,
});

const row = (id: string, extra: Partial<HostSessionSummary> = {}): HostSessionSummary => ({
  id, title: `Title ${id}`, directory: '/work/api', engine: 'claude', updatedAt: 1, state: 'idle', ...extra,
});

const project = (id: string, order: number, isDefault = false): HostProject => ({
  id, label: id.toUpperCase(), path: `/work/${id}`, order, isDefault,
});

test('watched servers list their projects with live states in a stable order, open a session, and keep their collapse', async () => {
  const dom = new Window({ url: 'http://localhost', width: 390, height: 844 });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useHostsStore } = await import('@/lib/hosts/hosts-store');
  const { MobileWatchedHosts } = await import('./MobileHostSections');
  const { useMobileHostCollapse } = await import('./useMobileHostCollapse');

  const store = useHostsStore.getState();
  store.syncHosts([descriptor('pi', 'Zeta Pi'), descriptor('mac', 'Alpha Mac')]);
  const seed = (hostId: string, sessions: HostSessionSummary[], connection: HostConnection, projects?: HostProject[]) => {
    const generation = store.beginGeneration(hostId);
    store.applySnapshot(hostId, generation, sessions, 1, projects);
    store.setConnection(hostId, generation, connection);
  };
  seed('mac', [
    row('asks', { projectId: 'api', state: 'waiting-permission', updatedAt: 5 }),
    row('web', { projectId: 'web', directory: '/work/web', state: 'running', updatedAt: 4 }),
    row('loose', { projectId: null, directory: '/tmp/loose', updatedAt: 3 }),
  ], { state: 'live', since: 1, via: 'stream' }, [project('web', 0), project('api', 1, true)]);
  seed('pi', [row('old')], { state: 'auth-required' });

  let opened = 0;
  let instances = 0;
  const Harness: React.FC = () => {
    const { collapsed, toggle } = useMobileHostCollapse();
    return <MobileWatchedHosts collapsed={collapsed} onToggle={toggle} onOpened={() => { opened += 1; }} onOpenInstances={() => { instances += 1; }} />;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(<I18nProvider><Harness /></I18nProvider>);
  });
  await render();

  const sections = () => [...container.querySelectorAll<HTMLElement>('section[data-host-id]')];
  expect(sections().map((section) => section.dataset.hostId)).toEqual(['mac', 'pi']);
  const mac = sections()[0];
  const groupLabels = [...mac.querySelectorAll('section .typography-ui-header')].map((element) => element.textContent);
  expect(groupLabels).toEqual(['API', 'WEB', 'loose']);
  expect(mac.textContent).toContain('Needs permission');
  expect(mac.textContent).toContain('Running');
  expect(sections()[1].textContent).toContain('Sign in needed');

  const asks = mac.querySelector<HTMLButtonElement>('button[aria-label^="Open Title asks"]');
  await act(async () => asks?.click());
  expect(opened).toBe(1);
  expect(openRequests.map((request) => [request.host.id, request.target])).toEqual([
    ['mac', { kind: 'session', sessionId: 'asks', directory: '/work/api' }],
  ]);

  const piSession = sections()[1].querySelector<HTMLButtonElement>('button[aria-label^="Open Title old"]');
  await act(async () => piSession?.click());
  expect(instances).toBe(1);
  expect(openRequests).toHaveLength(1);

  const macHeader = mac.querySelector<HTMLButtonElement>('button[aria-expanded]');
  await act(async () => macHeader?.click());
  expect(sections()[0].querySelector('section')).toBeNull();
  expect(JSON.parse(dom.localStorage.getItem('oc.mobile.hostCollapse') ?? '[]')).toEqual(['mac']);

  await act(async () => root.unmount());
  const remount = createRoot(container);
  await act(async () => {
    remount.render(<I18nProvider><Harness /></I18nProvider>);
  });
  expect(sections()[0].querySelector('section')).toBeNull();
  expect(sections()[1].querySelector('button[aria-expanded="true"]')).not.toBeNull();
  await act(async () => remount.unmount());
});

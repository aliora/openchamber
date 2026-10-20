import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import type { HostOpenRequest } from '@/lib/hosts/open-host-session';
import type { HostConnection, HostDescriptor, HostProject, HostSessionSummary, MonitoredHost } from '@/lib/hosts/types';

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
  id, title: `Title ${id}`, directory: '/work/api', updatedAt: 1, state: 'idle', work: null, ...extra,
});

const project = (id: string, order: number, isDefault = false): HostProject => ({
  id, label: id.toUpperCase(), path: `/work/${id}`, order, isDefault,
});

const monitored = (host: HostDescriptor, sessions: HostSessionSummary[], connection: HostConnection, projects?: HostProject[]): MonitoredHost => {
  const snapshot: MonitoredHost['snapshot'] = { status: 'ready', sessions: new Map(sessions.map((session) => [session.id, session])), lastCompleteAt: 1 };
  if (projects) snapshot.projects = projects;
  return { descriptor: host, connection, snapshot };
};

const installDom = () => {
  const dom = new Window({ url: 'http://localhost', width: 390, height: 844 });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
};

test('watched servers list their sessions in one ranked list with project chips, open a session, and keep their collapse', async () => {
  const dom = installDom();

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useHostsStore } = await import('@/lib/hosts/hosts-store');
  const { MobileWatchedHosts } = await import('./MobileHostSections');
  const { useMobileHostCollapse } = await import('./useMobileHostCollapse');

  useHostsStore.getState().replaceHosts([
    monitored(descriptor('pi', 'Zeta Pi'), [row('old')], { state: 'auth-required' }),
    monitored(descriptor('mac', 'Alpha Mac'), [
      row('asks', { projectId: 'api', state: 'waiting-permission', updatedAt: 5 }),
      row('web', { projectId: 'web', directory: '/work/web', state: 'running', updatedAt: 4 }),
      row('loose', { projectId: null, directory: '/tmp/loose', updatedAt: 3 }),
    ], { state: 'live', since: 1, via: 'stream' }, [project('web', 0), project('api', 1, true)]),
  ]);

  let opened = 0;
  const Harness: React.FC = () => {
    const { collapsed, toggle } = useMobileHostCollapse();
    return <MobileWatchedHosts collapsed={collapsed} onToggle={toggle} onOpened={() => { opened += 1; }} />;
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
  const sessionButtons = () => [...sections()[0].querySelectorAll<HTMLButtonElement>('button[aria-label^="Open Title"]')];
  const sessionLabels = () => sessionButtons().map((element) => element.getAttribute('aria-label'));
  expect(sessionLabels()).toEqual(['Open Title asks on Alpha Mac', 'Open Title web on Alpha Mac', 'Open Title loose on Alpha Mac']);
  expect(sessionButtons().map((element) => element.querySelector('.rounded')?.textContent ?? null)).toEqual([null, 'WEB', 'loose']);
  expect(mac.textContent).toContain('Needs permission');
  expect(mac.textContent).toContain('Running');
  expect(sections()[1].textContent).toContain('Sign in needed');

  const asks = mac.querySelector<HTMLButtonElement>('button[aria-label^="Open Title asks"]');
  await act(async () => asks?.click());
  expect(opened).toBe(1);
  expect(openRequests.map((request) => [request.host.id, request.target])).toEqual([
    ['mac', { kind: 'session', sessionId: 'asks', directory: '/work/api' }],
  ]);

  const newSession = mac.querySelector<HTMLButtonElement>('button[aria-label="New session"]');
  await act(async () => newSession?.click());
  expect(opened).toBe(2);
  expect(openRequests.map((request) => [request.host.id, request.target]).at(-1)).toEqual(
    ['mac', { kind: 'draft', directory: '/work/api' }],
  );

  const piSession = sections()[1].querySelector<HTMLButtonElement>('button[aria-label^="Open Title old"]');
  await act(async () => piSession?.click());
  expect(opened).toBe(3);
  expect(openRequests.map((request) => [request.host.id, request.target]).at(-1)).toEqual(
    ['pi', { kind: 'session', sessionId: 'old', directory: '/work/api' }],
  );

  const macHeader = mac.querySelector<HTMLButtonElement>('button[aria-expanded]');
  await act(async () => macHeader?.click());
  expect(sessionLabels()).toEqual([]);
  expect(JSON.parse(dom.localStorage.getItem('oc.mobile.hostCollapse') ?? '[]')).toEqual(['mac']);

  await act(async () => root.unmount());
  const remount = createRoot(container);
  await act(async () => {
    remount.render(<I18nProvider><Harness /></I18nProvider>);
  });
  expect(sessionLabels()).toEqual([]);
  expect(sections()[1].querySelector('button[aria-expanded="true"]')).not.toBeNull();
  await act(async () => remount.unmount());
});

test('the In work zone lists other servers\' sessions in work, named by their server, and opens one there', async () => {
  const dom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useHostsStore } = await import('@/lib/hosts/hosts-store');
  const { MobileRemoteWorkRows } = await import('./MobileHostSections');
  const { useMobileRemoteWork } = await import('./useMobileRemoteWork');

  useHostsStore.getState().replaceHosts([
    monitored(descriptor('mac', 'Alpha Mac'), [
      row('tracked', { work: 'open', updatedAt: 3 }),
      row('idle'),
      row('asks', { work: 'open', state: 'waiting-permission', updatedAt: 9 }),
    ], { state: 'live', since: 1, via: 'stream' }),
    monitored(descriptor('pi', 'Zeta Pi'), [row('pi-work', { work: 'open', updatedAt: 5 })], { state: 'live', since: 1, via: 'poll' }),
  ]);
  openRequests.length = 0;
  let opened = 0;
  const Harness: React.FC<{ enabled: boolean }> = ({ enabled }) => (
    <MobileRemoteWorkRows items={useMobileRemoteWork(enabled)} onOpened={() => { opened += 1; }} />
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><Harness enabled /></I18nProvider>);
  });

  const labels = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open Title"]')].map((element) => element.getAttribute('aria-label'));
  expect(labels()).toEqual(['Open Title pi-work on Zeta Pi', 'Open Title tracked on Alpha Mac']);
  expect(container.textContent).toContain('Zeta Pi');
  expect(container.textContent).toContain('Alpha Mac');

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Open Title pi-work"]')?.click());
  expect(opened).toBe(1);
  expect(openRequests.map((request) => [request.host.id, request.target])).toEqual([
    ['pi', { kind: 'session', sessionId: 'pi-work', directory: '/work/api' }],
  ]);

  await act(async () => {
    root.render(<I18nProvider><Harness enabled={false} /></I18nProvider>);
  });
  expect(labels()).toEqual([]);
  await act(async () => root.unmount());
  dom.happyDOM.abort();
});

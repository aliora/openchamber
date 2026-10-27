import { afterAll, expect, test } from 'bun:test';
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
const { OpencodeService } = await import('@/lib/opencode/client');
const { createRelayTunnelClient } = await import('@/lib/relay/tunnel-client');
const { hostRegistry } = await import('@/lib/hosts/runtime/app-host');
const { setMultiHostRuntime } = await import('@/lib/hosts/runtime/multi-host-flag');
const { createRuntimeTransport } = await import('@/lib/hosts/runtime/runtime-transport');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { FocusedHostGate } = await import('./FocusedHostGate');

const register = (name: string) => {
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: async () => new Response(null, { status: 404 }),
    createTunnel: createRelayTunnelClient,
  });
  transport.reconfigure({ apiBaseUrl: `https://${name}.example` });
  const runtimeKey = `host:${name}`;
  const client = new OpencodeService({ transport, runtimeKey: () => runtimeKey });
  return hostRegistry.register({
    descriptor: { id: name, label: name, kind: 'direct', displayUrl: `https://${name}.example`, runtimeKey, monitored: true },
    endpoint: { kind: 'direct', apiUrl: `https://${name}.example` },
  }, async () => null, { transport, client });
};

afterAll(() => {
  hostRegistry.unregister('host:pi');
  hostRegistry.unregister('host:pc');
  hostRegistry.unregister('host:mac');
  setMultiHostRuntime(false);
  void dom.happyDOM.abort();
});

test('a focused host that does not answer says why in its chat instead of an empty one, and its chat returns once it answers', async () => {
  setMultiHostRuntime(true);
  const pi = register('pi');
  const pc = register('pc');
  pi.status.setState({ connection: { state: 'backoff', failure: 'unreachable', retryAt: 5 } });
  pc.status.setState({ connection: { state: 'relay-limit' } });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const gated = (id: string) => (
    <FocusedHostGate key={id} hostId={id}><p data-chat={id}>chat</p></FocusedHostGate>
  );
  await act(async () => {
    root.render(<I18nProvider>{gated(pi.id)}{gated(pc.id)}</I18nProvider>);
  });

  const chats = () => [...container.querySelectorAll('[data-chat]')].map((element) => element.getAttribute('data-chat'));
  const marker = (id: string) => container.querySelector(`[data-host-offline="${id}"]`)?.textContent ?? null;
  expect(chats()).toEqual([]);
  expect(marker('host:pi')).toContain('pi is offline');
  expect(marker('host:pc')).toContain('pc reached the relay limit');

  await act(async () => pi.status.setState({ connection: { state: 'connecting' } }));
  expect(marker('host:pi')).toContain('Connecting to pi');

  await act(async () => pi.status.setState({ connection: { state: 'live', since: 9, via: 'stream' } }));
  expect(chats()).toEqual(['host:pi']);
  expect(marker('host:pi')).toBeNull();
  expect(marker('host:pc')).toContain('pc reached the relay limit');

  await act(async () => root.unmount());
});

test('a focused host with loaded sessions keeps its chat while reconnecting and only marks it offline', async () => {
  setMultiHostRuntime(true);
  const mac = register('mac');
  useGlobalSessionsStore.forHost(mac.id).getState().applySnapshot([], []);
  mac.status.setState({ connection: { state: 'backoff', failure: 'unreachable', retryAt: 5 } });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><FocusedHostGate hostId={mac.id}><p data-chat="mac">chat</p></FocusedHostGate></I18nProvider>);
  });

  const chat = container.querySelector('[data-chat="mac"]');
  expect(chat).not.toBeNull();
  expect(container.querySelector('[data-host-offline]')).toBeNull();
  expect(container.querySelector(`[data-host-offline-indicator="${mac.id}"]`)?.textContent).toContain('mac is offline');

  await act(async () => mac.status.setState({ connection: { state: 'live', since: 9, via: 'stream' } }));
  expect(container.querySelector('[data-host-offline-indicator]')).toBeNull();
  expect(container.querySelector('[data-chat="mac"]')).toBe(chat);

  await act(async () => root.unmount());
});

test('moving the focus between the window host and another host keeps the chat mounted', async () => {
  setMultiHostRuntime(true);
  const pi = hostRegistry.get('host:pi') ?? register('pi');
  pi.status.setState({ connection: { state: 'live', since: 1, via: 'stream' } });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = (hostId: string) => root.render(
    <I18nProvider><FocusedHostGate hostId={hostId}><p data-chat="column">chat</p></FocusedHostGate></I18nProvider>,
  );
  await act(async () => show('host:window-not-registered'));
  const chat = container.querySelector('[data-chat="column"]');
  expect(chat).not.toBeNull();

  await act(async () => show(pi.id));
  expect(container.querySelector('[data-chat="column"]')).toBe(chat);

  await act(async () => show('host:window-not-registered'));
  expect(container.querySelector('[data-chat="column"]')).toBe(chat);

  await act(async () => root.unmount());
});

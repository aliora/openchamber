import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createStore } from 'zustand';

import { opencodeClient } from '@/lib/opencode/client';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import type { SavedHost } from '../types';
import { HostScopeContext } from './HostScope';
import { runWithHost } from './ambient-host';
import { bindHostActions, createFocusFacade, createHostBindings } from './focus-facade';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import type { HostRuntime, HostStoreScope } from './types';

const savedHost = (id: string): SavedHost => ({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: false },
  endpoint: { kind: 'direct', apiUrl: `https://${id}.example` },
});

type Counter = { count: number; label: string };

const setup = () => {
  const registry = createHostRegistry(() => ({
    transport: createRuntimeTransport({
      bootInjection: false,
      fetch: async () => new Response(null, { status: 204 }),
      createTunnel: createRelayTunnelClient,
    }),
    client: opencodeClient,
  }));
  const a = registry.register(savedHost('a'), async () => null);
  const b = registry.register(savedHost('b'), async () => null);
  const { resolveHost, defineHostStore } = createHostBindings(registry);
  const created: string[] = [];
  const useCounter = defineHostStore<Counter>('counter', (host) => {
    created.push(host.id);
    return createStore<Counter>()(() => ({ count: 0, label: host.id }));
  });
  return { registry, a, b, resolveHost, useCounter, created };
};

class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return `hello ${this.name}`;
  }

  async greetLater(gate: Promise<void>): Promise<string> {
    await gate;
    return this.greet();
  }
}

describe('createFocusFacade', () => {
  test('reads, writes and membership go to the object resolved at the time of access', () => {
    const targets = { current: { value: 1, extra: 'x' } };
    const blueprint = { value: 0, extra: '' };
    const facade = createFocusFacade(blueprint, () => targets.current);

    expect(facade.value).toBe(1);
    expect('extra' in facade).toBe(true);
    targets.current = { value: 2, extra: 'y' };
    expect(facade.value).toBe(2);
    facade.value = 5;
    expect(targets.current.value).toBe(5);
    expect(blueprint).toEqual({ value: 0, extra: '' });
  });

  test('a method stays bound to the object it was read from, even after an await and a change of target', async () => {
    const targets = { current: new Greeter('a') };
    const facade = createFocusFacade(Greeter.prototype, () => targets.current);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const pending = facade.greetLater(gate);
    targets.current = new Greeter('b');
    release();

    expect(await pending).toBe('hello a');
    expect(facade.greet()).toBe('hello b');
  });

  test('a spy on a facade method intercepts the calls made through the facade until restored', () => {
    const facade = createFocusFacade(Greeter.prototype, () => new Greeter('a'));
    spyOn(facade, 'greet').mockReturnValue('spied');
    expect(facade.greet()).toBe('spied');
    mock.restore();
    expect(facade.greet()).toBe('hello a');
  });

  test('a member the target lacks reads as undefined', () => {
    const facade = createFocusFacade<{ value?: number }>({ value: 1 }, () => ({}));
    expect(facade.value).toBeUndefined();
  });
});

describe('resolveHost', () => {
  test('is the ambient host while one is set, else the focused host', () => {
    const { registry, a, b, resolveHost } = setup();
    expect(resolveHost()).toBe(a);
    expect(runWithHost(b, () => resolveHost())).toBe(b);
    registry.focus(b.id);
    expect(resolveHost()).toBe(b);
  });
});

describe('defineHostStore', () => {
  test('getState and setState reach the focused host, or the ambient one inside runWithHost', () => {
    const { registry, a, b, useCounter } = setup();

    useCounter.setState({ count: 1 });
    runWithHost(b, () => useCounter.setState((state) => ({ count: state.count + 10 })));
    expect(useCounter.getState()).toEqual({ count: 1, label: 'host:a' });
    expect(useCounter.forHost(b.id).getState()).toEqual({ count: 10, label: 'host:b' });
    expect(runWithHost(b, () => useCounter.getState().count)).toBe(10);

    registry.focus(b.id);
    expect(useCounter.getState().count).toBe(10);
    useCounter.setState({ count: 0, label: 'replaced' }, true);
    expect(useCounter.forHost(b.id).getState()).toEqual({ count: 0, label: 'replaced' });
    expect(useCounter.forHost(a.id).getState().count).toBe(1);
    expect(useCounter.getInitialState()).toEqual({ count: 0, label: 'host:b' });
  });

  test('creates each host store once, on first use', () => {
    const { a, b, useCounter, created } = setup();
    expect(created).toEqual([]);
    useCounter.getState();
    useCounter.getState();
    useCounter.forHost(a.id);
    useCounter.forHost(b.id);
    expect(created).toEqual(['host:a', 'host:b']);
  });

  test('forHost throws for an unknown host', () => {
    const { useCounter } = setup();
    expect(() => useCounter.forHost('host:missing')).toThrow('Unknown host: host:missing');
  });

  test('a subscriber follows the focus and hears the new and the previous state on a change', () => {
    const { registry, a, b, useCounter } = setup();
    useCounter.forHost(b.id).setState({ count: 7 });
    const heard: Array<[number, number]> = [];
    const unsubscribe = useCounter.subscribe((state, previous) => { heard.push([state.count, previous.count]); });

    useCounter.setState({ count: 1 });
    registry.focus(b.id);
    useCounter.forHost(a.id).setState({ count: 2 });
    useCounter.forHost(b.id).setState({ count: 8 });
    registry.register(savedHost('c'), async () => null);
    expect(heard).toEqual([[1, 0], [7, 1], [8, 7]]);

    unsubscribe();
    useCounter.forHost(b.id).setState({ count: 9 });
    registry.focus(a.id);
    expect(heard).toEqual([[1, 0], [7, 1], [8, 7]]);
  });

  test('a subscriber made inside runWithHost stays on that host', () => {
    const { registry, b, useCounter } = setup();
    const heard: number[] = [];
    const unsubscribe = runWithHost(b, () => useCounter.subscribe((state) => { heard.push(state.count); }));

    useCounter.setState({ count: 1 });
    useCounter.forHost(b.id).setState({ count: 2 });
    registry.focus(b.id);
    registry.focus('host:a');
    useCounter.forHost(b.id).setState({ count: 3 });
    expect(heard).toEqual([2, 3]);
    unsubscribe();
  });

  test('an every-host subscriber hears each host\'s store, already made or made later, with that host ambient', () => {
    const { registry, a, b, resolveHost, useCounter } = setup();
    useCounter.forHost(a.id).setState({ count: 1 });
    const heard: Array<[string, number, number, string]> = [];
    const unsubscribe = useCounter.subscribeEveryHost((state, previous, host) => {
      heard.push([host.id, state.count, previous.count, resolveHost().id]);
    });

    useCounter.forHost(a.id).setState({ count: 2 });
    useCounter.forHost(b.id).setState({ count: 5 });
    const c = registry.register(savedHost('c'), async () => null);
    useCounter.forHost(c.id).setState({ count: 9 });
    expect(heard).toEqual([['host:a', 2, 1, 'host:a'], ['host:b', 5, 0, 'host:b'], ['host:c', 9, 0, 'host:c']]);

    unsubscribe();
    useCounter.forHost(b.id).setState({ count: 6 });
    expect(heard).toHaveLength(3);
  });

  test('a subscriber whose focused host was replaced moves to the new runtime', () => {
    const { registry, a, useCounter } = setup();
    const heard: Array<[string, string]> = [];
    useCounter.subscribe((state, previous) => { heard.push([state.label, previous.label]); });
    useCounter.setState({ label: 'old a' });

    const replaced: HostRuntime = registry.register(savedHost('a'), async () => null);
    expect(replaced).not.toBe(a);
    expect(heard).toEqual([['old a', 'host:a'], ['host:a', 'old a']]);
  });
});

describe('bindHostActions', () => {
  test('runs each action with its host ambient for the synchronous part and keeps data members', async () => {
    const { b, resolveHost } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = bindHostActions(b, {
      label: 'kept',
      now: () => resolveHost().id,
      later: async () => {
        await gate;
        return resolveHost().id;
      },
    });

    expect(state.label).toBe('kept');
    expect(state.now()).toBe('host:b');
    const pending = state.later();
    release();
    expect(await pending).toBe('host:a');
  });
});

describe('defineHostValue', () => {
  test('creates one value per host, on first use', () => {
    const { registry, b } = setup();
    const { defineHostValue } = createHostBindings(registry);
    const readSeen = defineHostValue((host) => ({ host: host.id, seen: 0 }));

    readSeen().seen += 1;
    expect(readSeen()).toEqual({ host: 'host:a', seen: 1 });
    expect(runWithHost(b, readSeen)).toEqual({ host: 'host:b', seen: 0 });
  });

  test('a runtime that replaces its host with the same store scope keeps the host stores and values', () => {
    const scope: HostStoreScope = { hostId: 'host:a' };
    const registry = createHostRegistry(() => ({
      transport: createRuntimeTransport({
        bootInjection: false,
        fetch: async () => new Response(null, { status: 204 }),
        createTunnel: createRelayTunnelClient,
      }),
      client: opencodeClient,
      storeScope: scope,
    }));
    const first = registry.register(savedHost('a'), async () => null);
    const { defineHostStore, defineHostValue } = createHostBindings(registry);
    const useCounter = defineHostStore<Counter>('counter', () => createStore<Counter>()(() => ({ count: 0, label: 'a' })));
    const readSeen = defineHostValue(() => ({ seen: 0 }));
    useCounter.setState({ count: 3 });
    readSeen().seen += 1;

    const replaced = registry.register(savedHost('a'), async () => null);
    expect(replaced).not.toBe(first);
    expect(first.disposed).toBe(true);
    expect(useCounter.getState().count).toBe(3);
    expect(readSeen().seen).toBe(1);
  });
});

describe('the defineHostStore hook', () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    const dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
  });

  afterEach(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
  });

  test('reads the HostScope host first, else the focused host, and follows focus changes', async () => {
    const { registry, b, useCounter } = setup();
    const Focused = () => <span>{useCounter((state) => `${state.label}:${state.count}`)}</span>;
    const Scoped = () => <span>{useCounter().label}</span>;
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(
      <>
        <Focused />
        <HostScopeContext.Provider value={b.id}><Scoped /></HostScopeContext.Provider>
      </>,
    ));
    expect(container.innerHTML).toBe('<span>host:a:0</span><span>host:b</span>');

    await act(async () => useCounter.setState({ count: 4 }));
    expect(container.innerHTML).toBe('<span>host:a:4</span><span>host:b</span>');

    await act(async () => registry.focus(b.id));
    expect(container.innerHTML).toBe('<span>host:b:0</span><span>host:b</span>');

    await act(async () => root.unmount());
  });
});

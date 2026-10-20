import { describe, expect, test } from 'bun:test';
import { createStore, type StoreApi } from 'zustand';

import { opencodeClient } from '@/lib/opencode/client';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import type { SavedHost } from '../types';
import { getAmbientHost } from './ambient-host';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import type { HostRuntime, HostStoreKey } from './types';

const savedHost = (id: string): SavedHost => ({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: false },
  endpoint: { kind: 'direct', apiUrl: `https://${id}.example` },
});

const noCredential = async () => null;

const createTestRegistry = () => {
  const closed: string[] = [];
  const registry = createHostRegistry((host) => ({
    transport: Object.assign(createRuntimeTransport({
      bootInjection: false,
      fetch: async () => new Response(null, { status: 204 }),
      createTunnel: createRelayTunnelClient,
    }), {
      close: () => { closed.push(host.descriptor.runtimeKey); },
    }),
    client: opencodeClient,
  }));
  return { registry, closed };
};

const counterKey: HostStoreKey<{ count: number }> = (() => {
  const stores = new WeakMap<HostRuntime, StoreApi<{ count: number }>>();
  return {
    name: 'counter',
    resolve: (host) => {
      const existing = stores.get(host);
      if (existing) return existing;
      const created = createStore<{ count: number }>()(() => ({ count: 0 }));
      stores.set(host, created);
      return created;
    },
  };
})();

describe('host registry', () => {
  test('a registered host is keyed by its runtime key and the first one takes the focus', () => {
    const { registry } = createTestRegistry();
    const a = registry.register(savedHost('a'), noCredential);
    const b = registry.register(savedHost('b'), noCredential);

    expect(a.id).toBe('host:a');
    expect(registry.get('host:b')).toBe(b);
    expect(registry.list()).toEqual([a, b]);
    expect(registry.focused()).toBe(a);
    expect(a.status.getState()).toEqual({ connection: { state: 'connecting' } });
  });

  test('focus moves to a known host and rejects an unknown one', () => {
    const { registry } = createTestRegistry();
    registry.register(savedHost('a'), noCredential);
    const b = registry.register(savedHost('b'), noCredential);

    registry.focus('host:b');
    expect(registry.focused()).toBe(b);
    expect(() => registry.focus('host:missing')).toThrow('Unknown host: host:missing');
    expect(registry.focused()).toBe(b);
  });

  test('registering an id again replaces and disposes the previous runtime, keeping the focus on the id', () => {
    const { registry, closed } = createTestRegistry();
    const first = registry.register(savedHost('a'), noCredential);
    const second = registry.register(savedHost('a'), noCredential);

    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    expect(closed).toEqual(['host:a']);
    expect(registry.list()).toEqual([second]);
    expect(registry.focused()).toBe(second);
  });

  test('unregistering disposes the host and hands the focus to a remaining host', () => {
    const { registry, closed } = createTestRegistry();
    const a = registry.register(savedHost('a'), noCredential);
    const b = registry.register(savedHost('b'), noCredential);

    registry.unregister('host:a');
    expect(a.disposed).toBe(true);
    expect(closed).toEqual(['host:a']);
    expect(registry.focused()).toBe(b);

    registry.unregister('host:b');
    expect(registry.list()).toEqual([]);
    expect(() => registry.focused()).toThrow('No host is focused');
    registry.unregister('host:b');
    expect(closed).toEqual(['host:a', 'host:b']);
  });

  test('disposing twice closes the transport once', () => {
    const { registry, closed } = createTestRegistry();
    const a = registry.register(savedHost('a'), noCredential);
    a.dispose();
    a.dispose();
    expect(closed).toEqual(['host:a']);
  });

  test('listeners hear every change, and the list keeps its identity between changes', () => {
    const { registry } = createTestRegistry();
    let calls = 0;
    const unsubscribe = registry.subscribe(() => { calls += 1; });

    registry.register(savedHost('a'), noCredential);
    const listed = registry.list();
    expect(registry.list()).toBe(listed);
    registry.register(savedHost('b'), noCredential);
    registry.focus('host:b');
    registry.focus('host:b');
    registry.unregister('host:a');
    expect(calls).toBe(4);
    expect(registry.list()).not.toBe(listed);

    unsubscribe();
    registry.unregister('host:b');
    expect(calls).toBe(4);
  });

  test('run makes the host ambient for the call only', () => {
    const { registry } = createTestRegistry();
    const a = registry.register(savedHost('a'), noCredential);
    expect(a.run(() => getAmbientHost())).toBe(a);
    expect(getAmbientHost()).toBeNull();
  });

  test('instance gives each host its own store, the same one on every call', () => {
    const { registry } = createTestRegistry();
    const a = registry.register(savedHost('a'), noCredential);
    const b = registry.register(savedHost('b'), noCredential);

    a.instance(counterKey).setState({ count: 3 });
    expect(a.instance(counterKey)).toBe(a.instance(counterKey));
    expect(a.instance(counterKey).getState().count).toBe(3);
    expect(b.instance(counterKey).getState().count).toBe(0);
  });

  test('a host registered again on the same store scope hands the previous runtime its new transport', () => {
    const registry = createHostRegistry(() => { throw new Error('every part is given'); });
    const transportOf = (name: string) => Object.assign(createRuntimeTransport({
      bootInjection: false,
      fetch: async () => new Response(name),
      createTunnel: createRelayTunnelClient,
    }), { name });
    const storeScope = { hostId: 'host:a' };
    const first = registry.register(savedHost('a'), noCredential, { transport: transportOf('first'), client: opencodeClient, storeScope });
    const replacement = transportOf('second');
    const second = registry.register(savedHost('a'), noCredential, { transport: replacement, client: opencodeClient, storeScope });

    expect(first.disposed).toBe(true);
    expect(first.transport).toBe(replacement);
    expect(first.run(() => getAmbientHost())).toBe(second);

    const elsewhere = registry.register(savedHost('a'), noCredential, { transport: transportOf('third'), client: opencodeClient });
    expect(second.transport).toBe(replacement);
    expect(elsewhere.storeScope).not.toBe(storeScope);
  });

  test('parts handed to register are used instead of the registry factory', () => {
    const registry = createHostRegistry(() => { throw new Error('the factory is not asked'); });
    const transport = createRuntimeTransport({ bootInjection: false, fetch: async () => new Response(null), createTunnel: createRelayTunnelClient });
    const host = registry.register(savedHost('a'), noCredential, { transport, client: opencodeClient });
    expect(host.transport).toBe(transport);
  });
});

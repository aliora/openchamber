import { beforeEach, describe, expect, test } from 'bun:test';

import { useHostsStore } from './hosts-store';
import type { HostDescriptor, HostSessionSummary } from './types';

const descriptor = (id: string, label = id): HostDescriptor => ({
  id, label, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true,
});
const row = (id: string, extra: Partial<HostSessionSummary> = {}): HostSessionSummary => ({
  id, title: id, directory: '/w', engine: 'claude', updatedAt: 1, state: 'idle', ...extra,
});
const entry = (id: string) => useHostsStore.getState().hosts.find((host) => host.descriptor.id === id);

describe('hosts store', () => {
  beforeEach(() => {
    useHostsStore.getState().reset();
  });

  test('a new host starts connecting with no list yet, and syncing keeps known hosts as they are', () => {
    const store = useHostsStore.getState();
    store.syncHosts([descriptor('a'), descriptor('b')]);
    expect(entry('a')).toMatchObject({ connection: { state: 'connecting' }, snapshot: { status: 'loading', lastCompleteAt: null, generation: 0 } });

    const generation = store.beginGeneration('a');
    store.applySnapshot('a', generation, [row('s1')], 5);
    const before = entry('a');
    store.syncHosts([descriptor('b'), descriptor('a')]);
    expect(entry('a')).toBe(before);
    expect(useHostsStore.getState().hosts.map((host) => host.descriptor.id)).toEqual(['b', 'a']);

    store.syncHosts([descriptor('a', 'Renamed')]);
    expect(entry('a')?.descriptor.label).toBe('Renamed');
    expect(entry('a')?.snapshot).toBe(before?.snapshot);
    expect(entry('b')).toBeUndefined();
  });

  test('generations never repeat, so a host that comes back drops its earlier run\'s writes', () => {
    const store = useHostsStore.getState();
    store.syncHosts([descriptor('a')]);
    const first = store.beginGeneration('a');
    store.removeHost('a');
    store.syncHosts([descriptor('a')]);
    const second = store.beginGeneration('a');
    expect(second).toBeGreaterThan(first);

    store.applySnapshot('a', first, [row('old')], 1);
    store.markSnapshotError('a', first);
    expect(entry('a')?.snapshot.status).toBe('loading');
  });

  test('an unchanged row keeps its object, and an error keeps the list', () => {
    const store = useHostsStore.getState();
    store.syncHosts([descriptor('a')]);
    const generation = store.beginGeneration('a');
    store.applySnapshot('a', generation, [row('s1'), row('s2')], 1);
    const first = entry('a')?.snapshot.sessions;

    store.applySnapshot('a', generation, [row('s1'), row('s2', { state: 'running' })], 2);
    const second = entry('a')?.snapshot.sessions;
    expect(second?.get('s1')).toBe(first?.get('s1'));
    expect(second?.get('s2')?.state).toBe('running');

    store.applySnapshot('a', generation, [row('s1'), row('s2', { state: 'running' })], 3);
    expect(entry('a')?.snapshot.sessions).toBe(second);
    expect(entry('a')?.snapshot.lastCompleteAt).toBe(3);

    store.markSnapshotError('a', generation);
    expect(entry('a')?.snapshot).toMatchObject({ status: 'error', lastCompleteAt: 3 });
    expect(entry('a')?.snapshot.sessions).toBe(second);
  });
});

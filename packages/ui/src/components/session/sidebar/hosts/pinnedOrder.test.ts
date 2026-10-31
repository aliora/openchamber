import { describe, expect, test } from 'bun:test';
import type { HostDescriptor } from '@/lib/hosts/types';
import { movePinnedInOrder, pinnedOrderKeys, sortByPinnedOrder } from './pinnedOrder';

const descriptor = (id: string, label: string): HostDescriptor => ({
  id, label, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true,
});

const MSI = { descriptor: descriptor('msi', 'MSI'), serverId: 'srv-msi' };
const PI5 = { descriptor: descriptor('pi5', 'Pi5'), serverId: null };

describe('the Pinned order', () => {
  test('names a session by its host and id, the server id first', () => {
    expect(pinnedOrderKeys(MSI, 'ses_a')).toEqual(['server:srv-msi#ses_a', 'label:msi#ses_a']);
    expect(pinnedOrderKeys(PI5, 'ses_a')).toEqual(['label:pi5#ses_a']);
  });

  test('keeps the same session id on two hosts apart', () => {
    const items = [{ host: PI5, id: 'ses_a' }, { host: MSI, id: 'ses_a' }];
    const sorted = sortByPinnedOrder(items, (item) => pinnedOrderKeys(item.host, item.id), ['server:srv-msi#ses_a']);
    expect(sorted.map((item) => item.host.descriptor.id)).toEqual(['msi', 'pi5']);
  });

  test('lists saved entries first and the rest in the order they came', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(sortByPinnedOrder(items, (item) => [item], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  test('a move saves every shown entry and keeps the ones this client does not show', () => {
    const shown = [['server:x#1', 'label:x#1'], ['label:y#2'], ['label:y#3']];
    expect(movePinnedInOrder(['gone#9', 'label:x#1'], shown, 'label:y#3', 'server:x#1'))
      .toEqual(['label:y#3', 'server:x#1', 'label:y#2', 'gone#9']);
  });

  test('a move onto itself or an unknown entry changes nothing', () => {
    expect(movePinnedInOrder(['a'], [['a'], ['b']], 'a', 'a')).toEqual(['a']);
    expect(movePinnedInOrder(['a'], [['a'], ['b']], 'a', 'z')).toEqual(['a']);
  });
});

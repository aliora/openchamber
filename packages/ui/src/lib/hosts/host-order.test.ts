import { describe, expect, test } from 'bun:test';

import type { HostDescriptor } from './types';
import { hostOrderKeys, moveHostInOrder, primaryHostOrderKey, sortByHostOrder, type HostIdentity } from './host-order';

const host = (id: string, label: string, serverId: string | null = null): HostIdentity => ({
  descriptor: { id, label, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true } satisfies HostDescriptor,
  serverId,
});

const labels = (items: readonly HostIdentity[]) => items.map((item) => item.descriptor.label);

describe('host order keys', () => {
  test('prefer the server identity and keep the label as a fallback', () => {
    expect(hostOrderKeys(host('a', ' Mac  Mini ', 'srv-1'))).toEqual(['server:srv-1', 'label:mac mini']);
    expect(primaryHostOrderKey(host('a', 'Pi5'))).toBe('label:pi5');
  });
});

describe('sortByHostOrder', () => {
  test('follows the saved order whatever the client calls its hosts, and appends unknown hosts by label', () => {
    const onMsi = [host('local', 'This computer', 'msi'), host('host-mac', 'MAC', 'mac'), host('host-pi', 'PI5'), host('new', 'Zed'), host('other', 'Alpha')];
    const onMac = [host('host-msi', 'MSI', 'msi'), host('local', 'This Mac', 'mac'), host('pi', 'pi5')];
    const order = ['server:mac', 'label:pi5', 'server:msi'];

    expect(labels(sortByHostOrder(onMsi, (item) => item, order))).toEqual(['MAC', 'PI5', 'This computer', 'Alpha', 'Zed']);
    expect(labels(sortByHostOrder(onMac, (item) => item, order))).toEqual(['This Mac', 'pi5', 'MSI']);
  });

  test('with no saved order lists hosts by label', () => {
    expect(labels(sortByHostOrder([host('b', 'Pi5'), host('a', 'MAC')], (item) => item, []))).toEqual(['MAC', 'Pi5']);
  });
});

describe('moveHostInOrder', () => {
  test('moves a host and keeps keys of hosts this client does not show', () => {
    const shown = [host('mac', 'MAC', 'mac'), host('pi', 'PI5'), host('msi', 'MSI', 'msi')];
    expect(moveHostInOrder(['server:gone'], shown, 'server:msi', 'server:mac')).toEqual(['server:msi', 'server:mac', 'label:pi5', 'server:gone']);
  });

  test('leaves the order alone for an unknown host', () => {
    expect(moveHostInOrder(['label:a'], [host('a', 'A')], 'label:a', 'label:missing')).toEqual(['label:a']);
  });
});

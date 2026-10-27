import { describe, expect, test } from 'bun:test';
import type { HostConnection, HostDescriptor } from '@/lib/hosts/types';
import { isHiddenLocalHost, selectHostSessionPage, sortHostSessionEntries, type HostSessionEntry } from './hostSessionList';

type Flags = Partial<Pick<HostSessionEntry<string>, 'waiting' | 'running' | 'pinned' | 'current' | 'createdAt' | 'title'>>;

const entry = (id: string, updatedAt: number, flags: Flags = {}): HostSessionEntry<string> => ({
  id, value: id, title: id, createdAt: updatedAt, updatedAt, waiting: false, running: false, pinned: false, current: false, ...flags,
});

const range = (count: number): HostSessionEntry<string>[] => Array.from({ length: count }, (_, index) => entry(`s${index + 1}`, count - index));

describe('sortHostSessionEntries', () => {
  const list = [
    entry('old', 1, { title: 'Beta', createdAt: 9 }),
    entry('new', 9, { title: 'alpha', createdAt: 2 }),
    entry('running', 3, { running: true, title: 'Gamma', createdAt: 5 }),
    entry('waiting', 0, { waiting: true, title: 'delta', createdAt: 1 }),
  ];
  const ids = (order: Parameters<typeof sortHostSessionEntries>[1]) => sortHostSessionEntries(list, order).map((item) => item.id);

  test('orders by the last activity by default', () => {
    expect(ids(undefined)).toEqual(['new', 'running', 'old', 'waiting']);
  });

  test('orders by creation, by name and by state when asked', () => {
    expect(ids('created')).toEqual(['old', 'running', 'new', 'waiting']);
    expect(ids('name')).toEqual(['new', 'old', 'waiting', 'running']);
    expect(ids('status')).toEqual(['waiting', 'running', 'new', 'old']);
  });
});

describe('selectHostSessionPage', () => {
  const ids = (page: { visible: string[]; hiddenCount: number; canShowFewer: boolean }) => [...page.visible, `+${page.hiddenCount}`, page.canShowFewer ? 'fewer' : 'no-fewer'];

  test('shows three, then every session on Show more, then offers Show fewer', () => {
    const sorted = sortHostSessionEntries(range(25));
    expect(selectHostSessionPage(sorted).visible).toHaveLength(3);
    expect(selectHostSessionPage(sorted).hiddenCount).toBe(22);
    const all = selectHostSessionPage(sorted, Number.POSITIVE_INFINITY);
    expect(all.visible).toHaveLength(25);
    expect(all).toMatchObject({ hiddenCount: 0, canShowFewer: true });
  });

  test('waiting, pinned and open sessions always show and spend the three slots first', () => {
    const sorted = sortHostSessionEntries([
      entry('recent', 9),
      entry('pinned', 1, { pinned: true }),
      entry('waiting', 2, { waiting: true }),
      entry('older', 3),
      entry('oldest', 0),
    ]);
    expect(ids(selectHostSessionPage(sorted))).toEqual(['pinned', 'recent', 'waiting', '+2', 'no-fewer']);

    const many = sortHostSessionEntries([
      entry('open', 3, { current: true }),
      entry('p1', 2, { pinned: true }),
      entry('w1', 1, { waiting: true }),
      entry('p2', 0, { pinned: true }),
      entry('idle', 5),
    ]);
    expect(ids(selectHostSessionPage(many))).toEqual(['p1', 'p2', 'open', 'w1', '+1', 'no-fewer']);
  });

  test('a short list has nothing to hide', () => {
    expect(ids(selectHostSessionPage(sortHostSessionEntries([entry('a', 1)])))).toEqual(['a', '+0', 'no-fewer']);
  });
});

describe('isHiddenLocalHost', () => {
  const descriptor = (kind: HostDescriptor['kind']): HostDescriptor => ({
    id: kind, label: kind, kind, displayUrl: 'http://127.0.0.1:4100', runtimeKey: kind, monitored: true,
  });
  const live: HostConnection = { state: 'live', since: 1, via: 'stream' };
  const down: HostConnection = { state: 'backoff', failure: 'unreachable', retryAt: 2 };

  test('hides Local while it does not answer, never another host', () => {
    expect(isHiddenLocalHost({ descriptor: descriptor('local'), connection: down })).toBe(true);
    expect(isHiddenLocalHost({ descriptor: descriptor('local'), connection: { state: 'connecting' } })).toBe(true);
    expect(isHiddenLocalHost({ descriptor: descriptor('local'), connection: live })).toBe(false);
    expect(isHiddenLocalHost({ descriptor: descriptor('direct'), connection: down })).toBe(false);
  });
});

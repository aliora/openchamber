import { describe, expect, test } from 'bun:test';
import type { HostConnection, HostDescriptor } from '@/lib/hosts/types';
import { isHiddenLocalHost, selectHostSessionPage, sortHostSessionEntries, type HostSessionEntry } from './hostSessionList';

const entry = (id: string, updatedAt: number, flags: Partial<Pick<HostSessionEntry<string>, 'waiting' | 'running' | 'pinned'>> = {}): HostSessionEntry<string> => ({
  id, value: id, updatedAt, waiting: false, running: false, pinned: false, ...flags,
});

describe('sortHostSessionEntries', () => {
  test('puts what waits on the user first, then what runs, then pinned, then the rest by last activity', () => {
    const sorted = sortHostSessionEntries([
      entry('old', 1),
      entry('pinned', 2, { pinned: true }),
      entry('new', 9),
      entry('running', 3, { running: true }),
      entry('waiting', 0, { waiting: true }),
      entry('waiting-pinned', 5, { waiting: true, pinned: true }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['waiting-pinned', 'waiting', 'running', 'pinned', 'new', 'old']);
  });
});

describe('selectHostSessionPage', () => {
  const ids = (page: { visible: string[]; hiddenCount: number }) => [...page.visible, `+${page.hiddenCount}`];

  test('shows three and hides the rest behind Show more', () => {
    const sorted = sortHostSessionEntries([entry('a', 5), entry('b', 4), entry('c', 3), entry('d', 2), entry('e', 1)]);
    expect(ids(selectHostSessionPage(sorted, false))).toEqual(['a', 'b', 'c', '+2']);
    expect(ids(selectHostSessionPage(sorted, true))).toEqual(['a', 'b', 'c', 'd', 'e', '+0']);
  });

  test('waiting and pinned sessions always show and spend the three slots first', () => {
    const sorted = sortHostSessionEntries([
      entry('recent', 9),
      entry('pinned', 1, { pinned: true }),
      entry('waiting', 2, { waiting: true }),
      entry('older', 3),
    ]);
    expect(ids(selectHostSessionPage(sorted, false))).toEqual(['waiting', 'pinned', 'recent', '+1']);
  });

  test('more waiting and pinned sessions than slots all show, and nothing else does', () => {
    const sorted = sortHostSessionEntries([
      entry('w1', 4, { waiting: true }),
      entry('w2', 3, { waiting: true }),
      entry('p1', 2, { pinned: true }),
      entry('p2', 1, { pinned: true }),
      entry('running', 5, { running: true }),
    ]);
    expect(ids(selectHostSessionPage(sorted, false))).toEqual(['w1', 'w2', 'p1', 'p2', '+1']);
  });

  test('a short list has nothing to hide', () => {
    expect(ids(selectHostSessionPage(sortHostSessionEntries([entry('a', 1)]), false))).toEqual(['a', '+0']);
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

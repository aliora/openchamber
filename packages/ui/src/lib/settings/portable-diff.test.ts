import { describe, expect, test } from 'bun:test';

import { computePortableDiff } from './portable-diff';
import type { PortableItem, PortableSnapshot } from './portable-settings';

const item = (key: string, fingerprint: string, updatedAt: number | null = null): PortableItem => ({ key, label: key, fingerprint, updatedAt, paths: [] });

const snapshot = (mcp: PortableItem[], agents: PortableItem[] = []): PortableSnapshot => ({
  mcp: { status: 'ok', items: mcp },
  agents: { status: 'ok', items: agents },
});

describe('computePortableDiff', () => {
  test('lists only items that are missing somewhere or held in more than one version', () => {
    const rows = computePortableDiff([
      { hostId: 'mac', snapshot: snapshot([item('github', 'a'), item('same', 's'), item('only-mac', 'm')]) },
      { hostId: 'pi', snapshot: snapshot([item('github', 'b'), item('same', 's')]) },
    ]);

    expect(rows.map((row) => row.key)).toEqual(['github', 'only-mac']);
    expect([...rows[0].states]).toEqual([
      ['mac', { kind: 'present', version: 1, updatedAt: null, newest: false }],
      ['pi', { kind: 'present', version: 2, updatedAt: null, newest: false }],
    ]);
    expect(rows[1].states.get('pi')).toEqual({ kind: 'missing' });
  });

  test('an unreachable host is shown as such and does not make anything differ', () => {
    const rows = computePortableDiff([
      { hostId: 'mac', snapshot: snapshot([item('github', 'a')]) },
      { hostId: 'pi', snapshot: snapshot([item('github', 'a')]) },
      { hostId: 'msi', snapshot: null },
    ]);
    expect(rows).toEqual([]);

    const differing = computePortableDiff([
      { hostId: 'mac', snapshot: snapshot([item('github', 'a')]) },
      { hostId: 'pi', snapshot: snapshot([]) },
      { hostId: 'msi', snapshot: null },
    ]);
    expect(differing[0].states.get('msi')).toEqual({ kind: 'unreachable' });
    expect(differing[0].states.get('pi')).toEqual({ kind: 'missing' });
  });

  test('a category a host could not read is unknown there, never missing', () => {
    const rows = computePortableDiff([
      { hostId: 'mac', snapshot: { mcp: { status: 'ok', items: [item('github', 'a')] } } },
      { hostId: 'pi', snapshot: { mcp: { status: 'error' } } },
      { hostId: 'msi', snapshot: { mcp: { status: 'ok', items: [] } } },
    ]);
    expect(rows[0].states.get('pi')).toEqual({ kind: 'unknown' });
    expect(rows[0].states.get('msi')).toEqual({ kind: 'missing' });
  });

  test('marks the newest copy when the versions carry times', () => {
    const [row] = computePortableDiff([
      { hostId: 'mac', snapshot: snapshot([], [item('reviewer', 'a', 100)]) },
      { hostId: 'pi', snapshot: snapshot([], [item('reviewer', 'b', 300)]) },
    ]);
    expect(row.category).toBe('agents');
    expect(row.states.get('pi')).toEqual({ kind: 'present', version: 2, updatedAt: 300, newest: true });
    expect(row.states.get('mac')).toEqual({ kind: 'present', version: 1, updatedAt: 100, newest: false });
  });
});

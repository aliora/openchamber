import { describe, expect, it, vi } from 'vitest';

import { isPlainObject } from '../shared/guards.js';
import { createPortableSettingsCatalog, expandPortablePath, fingerprintOf, toPortablePath } from './catalog.js';

const fakeCategory = (initial, overrides = {}) => {
  const items = new Map(initial.map((item) => [item.key, item]));
  const writes = [];
  const removals = [];
  return {
    items,
    writes,
    removals,
    adapter: {
      list: async () => [...items.values()],
      parse: (_key, value) => (isPlainObject(value) ? value : null),
      requiredPaths: (_key, value) => value.paths ?? [],
      write: async (key, value) => {
        writes.push({ key, value });
        items.set(key, { key, label: key, value, updatedAt: 500 });
      },
      remove: async (key) => {
        removals.push(key);
        items.delete(key);
      },
      ...overrides,
    },
  };
};

const silentLogger = { warn: vi.fn() };

const catalogWith = (categories, existingPaths = []) => createPortableSettingsCatalog({
  categories,
  pathExists: async (target) => existingPaths.includes(target),
  expandPath: (portablePath) => portablePath.replace('~', '/home/target'),
  logger: silentLogger,
});

describe('portable settings catalog', () => {
  it('describes every item by fingerprint and leaves values out of the snapshot', async () => {
    const mcp = fakeCategory([{ key: 'github', label: 'github', value: { type: 'remote', headers: { Authorization: 'Bearer secret-token' } }, updatedAt: null }]);
    const catalog = catalogWith({ mcp: mcp.adapter });

    const snapshot = await catalog.snapshot();

    expect(snapshot.categories.mcp).toEqual({
      status: 'ok',
      items: [{ key: 'github', label: 'github', fingerprint: fingerprintOf(mcp.items.get('github').value), updatedAt: null, paths: [] }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
  });

  it('reports a category it cannot read as an error instead of an empty list', async () => {
    const broken = fakeCategory([], { list: async () => { throw new Error('store is invalid'); } });
    const agents = fakeCategory([{ key: 'reviewer', label: 'reviewer', value: { a: 1 }, updatedAt: 1 }]);
    const snapshot = await catalogWith({ mcp: broken.adapter, agents: agents.adapter }).snapshot();

    expect(snapshot.categories.mcp).toEqual({ status: 'error' });
    expect(snapshot.categories.agents.status).toBe('ok');
  });

  it('fingerprints ignore key order', () => {
    expect(fingerprintOf({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprintOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });

  it('exports the values asked for and says which are missing or refused', async () => {
    const skills = fakeCategory([
      { key: 'small', label: 'small', value: { files: [] }, updatedAt: 3 },
      { key: 'huge', label: 'huge', value: { files: [] }, updatedAt: 3, tooLarge: true },
    ], { exportRefusal: (item) => (item.tooLarge ? 'too-large' : null) });
    const exported = await catalogWith({ skills: skills.adapter }).exportItems([
      { category: 'skills', key: 'small' },
      { category: 'skills', key: 'huge' },
      { category: 'skills', key: 'gone' },
    ]);

    expect(exported).toEqual([
      { category: 'skills', key: 'small', status: 'found', value: { files: [] }, updatedAt: 3 },
      { category: 'skills', key: 'huge', status: 'refused', reason: 'too-large' },
      { category: 'skills', key: 'gone', status: 'missing' },
    ]);
  });

  it('refuses an item whose folder does not exist on this instance and writes the others', async () => {
    const projects = fakeCategory([]);
    const catalog = catalogWith({ projects: projects.adapter }, ['/home/target/work/app']);

    const results = await catalog.importItems({
      items: [
        { category: 'projects', key: '~/work/missing', value: { paths: ['~/work/missing'] } },
        { category: 'projects', key: '~/work/app', value: { paths: ['~/work/app'] } },
      ],
    });

    expect(results).toEqual([
      { category: 'projects', key: '~/work/missing', status: 'refused', reason: 'path-missing', path: '~/work/missing' },
      { category: 'projects', key: '~/work/app', status: 'applied' },
    ]);
    expect(projects.writes.map((write) => write.key)).toEqual(['~/work/app']);
  });

  it('keeps a newer item unless the write is forced', async () => {
    const agents = fakeCategory([{ key: 'reviewer', label: 'reviewer', value: { v: 'target' }, updatedAt: 200 }]);
    const catalog = catalogWith({ agents: agents.adapter });

    const skipped = await catalog.importItems({ items: [{ category: 'agents', key: 'reviewer', value: { v: 'old' }, updatedAt: 100 }] });
    expect(skipped).toEqual([{ category: 'agents', key: 'reviewer', status: 'skipped', reason: 'target-newer' }]);

    const forced = await catalog.importItems({ items: [{ category: 'agents', key: 'reviewer', value: { v: 'old' }, updatedAt: 100 }], force: true });
    expect(forced).toEqual([{ category: 'agents', key: 'reviewer', status: 'applied' }]);
  });

  it('reports an identical item as unchanged without writing it', async () => {
    const agents = fakeCategory([{ key: 'reviewer', label: 'reviewer', value: { v: 1 }, updatedAt: 1 }]);
    const results = await catalogWith({ agents: agents.adapter }).importItems({ items: [{ category: 'agents', key: 'reviewer', value: { v: 1 } }] });
    expect(results).toEqual([{ category: 'agents', key: 'reviewer', status: 'unchanged' }]);
    expect(agents.writes).toEqual([]);
  });

  it('a failed write does not stop the next item', async () => {
    const commands = fakeCategory([], {
      write: async (key) => {
        if (key === 'broken') throw new Error('disk full');
      },
    });
    const results = await catalogWith({ commands: commands.adapter }).importItems({
      items: [
        { category: 'commands', key: 'broken', value: {} },
        { category: 'commands', key: 'fine', value: {} },
      ],
    });
    expect(results).toEqual([
      { category: 'commands', key: 'broken', status: 'failed', reason: 'error' },
      { category: 'commands', key: 'fine', status: 'applied' },
    ]);
  });

  it('removes items, leaving a newer one in place unless forced', async () => {
    const mcp = fakeCategory([
      { key: 'old', label: 'old', value: {}, updatedAt: 10 },
      { key: 'fresh', label: 'fresh', value: {}, updatedAt: 1_000 },
    ]);
    const results = await catalogWith({ mcp: mcp.adapter }).importItems({
      removals: [
        { category: 'mcp', key: 'old', updatedAt: 100 },
        { category: 'mcp', key: 'fresh', updatedAt: 100 },
        { category: 'mcp', key: 'absent', updatedAt: 100 },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(['removed', 'skipped', 'unchanged']);
    expect(mcp.removals).toEqual(['old']);
  });

  it('never logs item values', async () => {
    const logger = { warn: vi.fn() };
    const mcp = fakeCategory([], { write: async () => { throw new Error('write failed'); } });
    const catalog = createPortableSettingsCatalog({ categories: { mcp: mcp.adapter }, pathExists: async () => true, logger });
    await catalog.importItems({ items: [{ category: 'mcp', key: 'github', value: { env: { TOKEN: 'secret-token' } } }] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token');
  });
});

describe('portable paths', () => {
  it('maps a folder under the home folder to ~ and back', () => {
    expect(toPortablePath('/Users/me/work/app', '/Users/me')).toBe('~/work/app');
    expect(toPortablePath('/Users/me', '/Users/me')).toBe('~');
    expect(toPortablePath('/opt/tools', '/Users/me')).toBe('/opt/tools');
    expect(expandPortablePath('~/work/app', '/home/pi')).toBe('/home/pi/work/app');
    expect(expandPortablePath('/opt/tools', '/home/pi')).toBe('/opt/tools');
  });
});

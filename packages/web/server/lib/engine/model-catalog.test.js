import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelCatalog, createModelCatalogStore } from './model-catalog.js';

const FALLBACK = { models: [{ id: 'old', name: 'Old' }], defaultModel: 'old' };
const LIVE = { models: [{ id: 'new', name: 'New', efforts: ['low', 'high'] }, { id: 'old', name: 'Old' }], defaultModel: 'new' };

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('createModelCatalogStore', () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-model-store-test-'));
    filePath = path.join(tmpDir, 'nested', 'engine-models.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps each engine list across restarts', async () => {
    const store = createModelCatalogStore({ filePath });
    expect(store.load('claude')).toBeNull();

    await store.save('claude', LIVE);
    await store.save('codex', FALLBACK);

    const restarted = createModelCatalogStore({ filePath });
    expect(restarted.load('claude')).toEqual(LIVE);
    expect(restarted.load('codex')).toEqual(FALLBACK);
  });

  it('ignores a stored list it cannot use and moves a missing default to the first model', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      claude: { models: [], defaultModel: 'x' },
      codex: { models: [{ id: 'a', name: 'A' }], defaultModel: 'gone' },
    }));
    const store = createModelCatalogStore({ filePath });
    expect(store.load('claude')).toBeNull();
    expect(store.load('codex')).toEqual({ models: [{ id: 'a', name: 'A' }], defaultModel: 'a' });
  });

  it('starts empty from a file that does not parse, and says so', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{');
    const warnings = [];
    const store = createModelCatalogStore({ filePath, warn: (message) => warnings.push(message) });
    expect(store.load('claude')).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('createModelCatalog', () => {
  const setup = ({ reads = [], stored = null } = {}) => {
    const state = { reads: 0, saved: [], changes: [], warnings: [] };
    const catalog = createModelCatalog({
      id: 'test',
      fallback: FALLBACK,
      read: async () => {
        state.reads += 1;
        const next = reads.shift() ?? LIVE;
        if (next instanceof Error) throw next;
        return next;
      },
      identify: () => 'test 1.0.0',
      store: {
        load: () => stored,
        save: (id, saved) => state.saved.push([id, saved]),
      },
      warn: (message) => state.warnings.push(message),
    });
    catalog.subscribe((next) => state.changes.push(next));
    return { catalog, state };
  };

  it('serves the stored list before the first read', () => {
    const { catalog } = setup({ stored: LIVE });
    expect(catalog.current()).toBe(LIVE);
  });

  it('stores and announces a list that changed, and only then', async () => {
    const { catalog, state } = setup();
    await catalog.start();
    expect(catalog.current()).toEqual(LIVE);
    expect(state.saved).toEqual([['test', LIVE]]);
    expect(state.changes).toEqual([LIVE]);

    await catalog.refresh();
    expect(state.reads).toBe(2);
    expect(state.saved).toHaveLength(1);
    expect(state.changes).toHaveLength(1);
  });

  it('reads nothing on refresh before the server started it', async () => {
    const { catalog, state } = setup();
    expect(await catalog.refresh()).toBe(FALLBACK);
    expect(state.reads).toBe(0);
  });

  it('reads again on refresh within the TTL, and moves a default the list lost to its first model', async () => {
    const withoutDefault = { models: [{ id: 'only', name: 'Only' }], defaultModel: 'gone' };
    const { catalog, state } = setup({ reads: [LIVE, withoutDefault] });
    await catalog.start();

    expect(await catalog.refresh()).toEqual({ models: [{ id: 'only', name: 'Only' }], defaultModel: 'only' });
    expect(state.reads).toBe(2);
  });

  it('rejects a refresh whose read failed and keeps serving the last list', async () => {
    const { catalog, state } = setup({ reads: [LIVE, new Error('agy listed no models')] });
    await catalog.start();

    await expect(catalog.refresh()).rejects.toThrow('agy listed no models');
    expect(catalog.current()).toEqual(LIVE);
    expect(state.reads).toBe(2);
  });

  it('waits for a read in progress before it reads again', async () => {
    const { catalog, state } = setup();
    const started = catalog.start();
    const refreshed = catalog.refresh();
    await Promise.all([started, refreshed]);
    await settle();
    expect(state.reads).toBe(2);
  });
});

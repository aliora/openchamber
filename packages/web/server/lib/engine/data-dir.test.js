import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { resolveEngineDataDir } from './data-dir.js';

const home = path.resolve('/home/someone');

describe('resolveEngineDataDir', () => {
  it('keeps the shared default folder when no data directory is set', () => {
    expect(resolveEngineDataDir({ env: {}, home })).toBe(path.join(home, '.openchamber', 'data'));
  });

  it('treats an empty data directory as unset', () => {
    expect(resolveEngineDataDir({ env: { OPENCHAMBER_DATA_DIR: '' }, home })).toBe(path.join(home, '.openchamber', 'data'));
  });

  it('keeps the default folder when the data directory names the default root', () => {
    const env = { OPENCHAMBER_DATA_DIR: path.join(home, '.config', 'openchamber') };
    expect(resolveEngineDataDir({ env, home })).toBe(path.join(home, '.openchamber', 'data'));
  });

  it('moves engine files under a custom data directory', () => {
    const env = { OPENCHAMBER_DATA_DIR: path.resolve('/srv/second-instance') };
    expect(resolveEngineDataDir({ env, home })).toBe(path.join(path.resolve('/srv/second-instance'), 'engine'));
  });

  it('resolves a relative data directory', () => {
    const env = { OPENCHAMBER_DATA_DIR: 'relative-data' };
    expect(resolveEngineDataDir({ env, home })).toBe(path.join(path.resolve('relative-data'), 'engine'));
  });
});

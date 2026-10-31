import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import { createFileFinder } from './file-find.js';

const fakeRipgrep = (listing, { code = 0 } = {}) => {
  const runs = [];
  const spawn = (binary, args, options) => {
    runs.push({ binary, args, cwd: options.cwd });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    setImmediate(() => {
      child.stdout.end(listing);
      child.stdout.on('end', () => child.emit('close', code));
      child.stdout.resume();
    });
    return child;
  };
  return { spawn, runs };
};

const LISTING = ['README.md', 'src/stop-button.tsx', 'src/session/stop.ts', 'packages/web/server/index.js', ''].join('\n');

describe('createFileFinder', () => {
  it('ranks name matches before path matches and shorter paths first', async () => {
    const { spawn, runs } = fakeRipgrep(LISTING);
    const finder = createFileFinder({ spawn, resolveRipgrepBinary: async () => '/bin/rg' });

    const found = await finder.find('/work/app', { query: 'stop', limit: 10 });

    expect(found).toEqual([
      { path: 'src/session/stop.ts', type: 'file' },
      { path: 'src/stop-button.tsx', type: 'file' },
    ]);
    expect(runs).toEqual([{ binary: '/bin/rg', args: ['--files', '--no-messages'], cwd: '/work/app' }]);
  });

  it('lists folders as directories and caps the answer at the limit', async () => {
    const { spawn } = fakeRipgrep(LISTING);
    const finder = createFileFinder({ spawn, resolveRipgrepBinary: async () => '/bin/rg' });

    expect(await finder.find('/work/app', { query: 'se', type: 'directory', limit: 10 })).toEqual([
      { path: 'src/session', type: 'directory' },
      { path: 'packages/web/server', type: 'directory' },
      { path: 'packages/web', type: 'directory' },
    ]);
    expect(await finder.find('/work/app', { query: '', type: 'file', limit: 1 })).toHaveLength(1);
  });

  it('lists a workspace once while the listing is fresh and again after it expires', async () => {
    let time = 0;
    const { spawn, runs } = fakeRipgrep(LISTING);
    const finder = createFileFinder({ spawn, resolveRipgrepBinary: async () => '/bin/rg', ttlMs: 1000, now: () => time });

    await Promise.all([finder.find('/work/app', { query: 'a' }), finder.find('/work/app', { query: 'b' })]);
    time = 500;
    await finder.find('/work/app', { query: 'c' });
    expect(runs).toHaveLength(1);

    time = 2000;
    await finder.find('/work/app', { query: 'd' });
    expect(runs).toHaveLength(2);
  });

  it('reports a failed listing as an error rather than an empty answer', async () => {
    const missing = createFileFinder({ spawn: fakeRipgrep('').spawn, resolveRipgrepBinary: async () => null });
    await expect(missing.find('/work/app', { query: 'x' })).rejects.toThrow('ripgrep is not available on this server');

    const failing = createFileFinder({ spawn: fakeRipgrep('', { code: 2 }).spawn, resolveRipgrepBinary: async () => '/bin/rg' });
    await expect(failing.find('/work/app', { query: 'x' })).rejects.toThrow('ripgrep exited with code 2');
  });
});

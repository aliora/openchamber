import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { buildChromeArgs, launchBrowser } from './browser-process.js';

const fakeChild = () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  return child;
};

describe('buildChromeArgs', () => {
  it('runs headless with a private profile and a loopback-only debugging port', () => {
    const args = buildChromeArgs({ profileDir: '/p', runningAsRoot: false, platform: 'darwin' });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--user-data-dir=/p');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).not.toContain('--no-sandbox');
  });

  it('adds what a root Linux server needs', () => {
    const args = buildChromeArgs({ profileDir: '/p', runningAsRoot: true, platform: 'linux' });
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-dev-shm-usage');
  });
});

describe('launchBrowser', () => {
  const connection = { close() { connection.closed = true; } };

  it('connects to the address the browser prints and kills it on stop', async () => {
    const child = fakeChild();
    const dirs = [];
    const connected = [];
    const pending = launchBrowser({
      chromePath: '/chrome',
      profileDir: '/p',
      spawn: () => child,
      connect: async (url) => { connected.push(url); return connection; },
      mkdir: (directory) => dirs.push(directory),
    });
    child.stderr.emit('data', 'noise\nDevTools listening on ws://127.0.0.1:9333/devtools/browser/abc\n');
    const browser = await pending;
    expect(dirs).toEqual(['/p']);
    expect(connected).toEqual(['ws://127.0.0.1:9333/devtools/browser/abc']);
    await browser.stop();
    expect(child.killed).toBe(true);
    expect(connection.closed).toBe(true);
  });

  it('reports a browser that dies while starting with what it said', async () => {
    const child = fakeChild();
    const pending = launchBrowser({ chromePath: '/chrome', profileDir: '/p', spawn: () => child, connect: async () => connection, mkdir: () => undefined });
    child.stderr.emit('data', 'profile is locked');
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow('profile is locked');
  });

  it('reports a browser that cannot be started at all', async () => {
    const child = fakeChild();
    const pending = launchBrowser({ chromePath: '/chrome', profileDir: '/p', spawn: () => child, connect: async () => connection, mkdir: () => undefined });
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('could not be started: ENOENT');
  });

  it('gives up on a browser that never prints its address', async () => {
    const child = fakeChild();
    await expect(launchBrowser({ chromePath: '/chrome', profileDir: '/p', spawn: () => child, connect: async () => connection, mkdir: () => undefined, timeoutMs: 20 }))
      .rejects.toThrow('did not start');
    expect(child.killed).toBe(true);
  });
});

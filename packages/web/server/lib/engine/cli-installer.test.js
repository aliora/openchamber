import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLatestVersionLookup, isNewerVersion, CliInstaller, resolvePackageManager } from './cli-installer.js';
import { createFakeSpawn, flushMicrotasks } from './test/fake-cli.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isNewerVersion', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewerVersion('2.1.301', '2.1.300')).toBe(true);
    expect(isNewerVersion('0.163.0', '0.162.1')).toBe(true);
    expect(isNewerVersion('2.1.300', '2.1.300')).toBe(false);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('treats a missing side as no update', () => {
    expect(isNewerVersion(null, '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', null)).toBe(false);
  });
});

describe('createLatestVersionLookup', () => {
  it('answers null first and the fetched version after the background read', async () => {
    const lookup = createLatestVersionLookup({ packageName: '@openai/codex', fetchLatest: async () => '0.163.0' });
    expect(lookup.peek()).toBeNull();
    await flush();
    expect(lookup.peek()).toBe('0.163.0');
  });

  it('reads once within the cache window', async () => {
    let calls = 0;
    let clock = 0;
    const lookup = createLatestVersionLookup({
      packageName: 'x',
      fetchLatest: async () => { calls += 1; return '1.0.0'; },
      now: () => clock,
      ttlMs: 1000,
    });
    lookup.peek();
    await flush();
    lookup.peek();
    await flush();
    expect(calls).toBe(1);
    clock = 2000;
    lookup.peek();
    await flush();
    expect(calls).toBe(2);
  });

  it('keeps null when the registry cannot be reached', async () => {
    const lookup = createLatestVersionLookup({ packageName: 'x', fetchLatest: async () => { throw new Error('offline'); } });
    lookup.peek();
    await flush();
    expect(lookup.peek()).toBeNull();
  });
});

describe('CliInstaller status', () => {
  it('reports an update when the registry is ahead of the installed CLI', async () => {
    const installer = new CliInstaller(
      { packageName: '@openai/codex', detect: () => ({ installed: true, version: '0.162.1', managedByNpm: true }) },
      { fetchLatest: async () => '0.163.0' },
    );
    installer.getStatus();
    await flush();
    const status = installer.getStatus();
    expect(status.latestVersion).toBe('0.163.0');
    expect(status.updateAvailable).toBe(true);
  });

  it('offers no update for a CLI it cannot update', async () => {
    const installer = new CliInstaller(
      { packageName: '@anthropic-ai/claude-code', detect: () => ({ installed: true, version: '2.1.0' }) },
      { fetchLatest: async () => '2.2.0' },
    );
    installer.getStatus();
    await flush();
    const status = installer.getStatus();
    expect(status.latestVersion).toBe('2.2.0');
    expect(status.updateAvailable).toBe(false);
    expect(status.packageManager).toBeNull();
  });

  it('reports no update for a missing CLI', async () => {
    const installer = new CliInstaller(
      { packageName: '@openai/codex', detect: () => ({ installed: false, version: null }) },
      { fetchLatest: async () => '0.163.0' },
    );
    installer.getStatus();
    await flush();
    expect(installer.getStatus().updateAvailable).toBe(false);
  });
});

describe('resolvePackageManager', () => {
  it('finds the Homebrew npm on Apple silicon', () => {
    const pm = resolvePackageManager({ platform: 'darwin', env: { HOME: '/tmp/none' }, fileExists: (loc) => loc === '/opt/homebrew/bin/npm' });
    expect(pm.command).toBe('/opt/homebrew/bin/npm');
  });
});

describe('CliInstaller actions', () => {
  let home;
  let spawn;
  let detection;

  const npmInstalled = { installed: true, version: '0.162.1', command: '/prefix/bin/codex', managedByNpm: true };

  const createInstaller = (spec = {}, options = {}) => new CliInstaller(
    { packageName: '@openai/codex', detect: () => detection, doctorArgs: ['doctor'], configPaths: (dir) => [path.join(dir, '.codex')], ...spec },
    { platform: 'linux', env: { HOME: home }, home, fileExists: (loc) => fs.existsSync(loc) && loc.startsWith(home), fetchLatest: async () => '0.163.0', spawnProcess: spawn.spawnProcess, ...options },
  );

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-actions-'));
    spawn = createFakeSpawn();
    detection = npmInstalled;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('offers every npm action with the command it runs', () => {
    const status = createInstaller().getStatus();
    expect(status.installSource).toBe('npm');
    expect(status.actions).toEqual({ install: true, update: true, uninstall: true, reinstall: true, doctor: true });
    expect(status.commands).toEqual({
      install: 'npm install -g @openai/codex@latest',
      update: 'npm install -g @openai/codex@latest',
      uninstall: 'npm uninstall -g @openai/codex',
      reinstall: 'npm install -g @openai/codex@latest --force',
      doctor: '/prefix/bin/codex doctor',
    });
    expect(status.action).toBeNull();
  });

  it('offers only install for a missing CLI', () => {
    detection = { installed: false, version: null, command: null };
    const status = createInstaller().getStatus();
    expect(status.installSource).toBe('unknown');
    expect(status.actions).toEqual({ install: true, update: false, uninstall: false, reinstall: false, doctor: false });
    expect(status.canInstall).toBe(true);
    expect(status.installCommand).toBe('npm install -g @openai/codex@latest');
  });

  it('streams an update and reports the action in every status event', async () => {
    const installer = createInstaller();
    const statuses = [];
    const logs = [];
    installer.on('status', (event) => statuses.push([event.state, event.action]));
    installer.on('log', (entry) => logs.push(entry.text));

    const running = installer.runAction('update');
    expect(installer.getStatus()).toMatchObject({ state: 'installing', action: 'update' });
    expect(spawn.calls[0]).toMatchObject({ command: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
    expect(spawn.calls[0].options.stdio[0]).toBe('ignore');
    spawn.finish(0, 'added 1 package\n');
    await running;

    expect(statuses).toEqual([['installing', 'update'], ['completed', 'update']]);
    expect(logs).toContain('added 1 package\n');
    expect(installer.getStatus()).toMatchObject({ state: 'completed', action: 'update' });
  });

  it('runs one action at a time', async () => {
    const installer = createInstaller();
    const first = installer.runAction('doctor');
    await expect(installer.runAction('update')).rejects.toMatchObject({ code: 'busy' });
    expect(spawn.calls).toHaveLength(1);
    spawn.finish(0);
    await first;
  });

  it('refuses an action the installation does not offer without starting anything', async () => {
    detection = { installed: false, version: null, command: null };
    await expect(createInstaller().runAction('uninstall')).rejects.toMatchObject({ code: 'unsupported' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('reports a failed step with its exit code', async () => {
    const installer = createInstaller();
    const running = installer.runAction('reinstall');
    spawn.finish(1);
    await expect(running).rejects.toThrow('npm install -g @openai/codex@latest --force exited with code 1');
    expect(installer.getStatus()).toMatchObject({ state: 'failed', action: 'reinstall', lastError: expect.stringContaining('code 1') });
  });

  it('keeps the configuration on uninstall unless asked to remove it', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const installer = createInstaller();

    const kept = installer.runAction('uninstall');
    spawn.finish(0);
    await kept;
    expect(spawn.calls[0].args).toEqual(['uninstall', '-g', '@openai/codex']);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(true);

    const removed = installer.runAction('uninstall', { removeConfig: true });
    spawn.finish(0);
    await removed;
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('refuses to remove a path outside the home folder', async () => {
    const removed = [];
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-outside-'));
    const installer = createInstaller(
      { configPaths: () => [outside] },
      { fileExists: fs.existsSync, removePath: (target) => removed.push(target) },
    );
    await expect(installer.runAction('uninstall', { removeConfig: true })).rejects.toThrow('Refusing to remove');
    expect(removed).toEqual([]);
    expect(spawn.calls).toHaveLength(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('names a Homebrew installation and offers only the doctor', () => {
    const cellar = path.join(home, 'Cellar', 'codex', '1.0.0');
    fs.mkdirSync(cellar, { recursive: true });
    fs.writeFileSync(path.join(cellar, 'codex'), '');
    detection = { installed: true, version: '1.0.0', command: path.join(cellar, 'codex') };
    const status = createInstaller().getStatus();
    expect(status.installSource).toBe('brew');
    expect(status.actions).toEqual({ install: false, update: false, uninstall: false, reinstall: false, doctor: true });
    expect(status.commands.update).toBeNull();
  });

  it('tracks the latest version for a native installation', async () => {
    detection = { installed: true, version: '0.162.1', command: '/native/codex' };
    const installer = createInstaller({
      nativePlan: () => ({ update: [{ command: '/native/codex', args: ['update'] }], reinstall: null, uninstall: null }),
    });
    installer.getStatus();
    await flushMicrotasks();
    const status = installer.getStatus();
    expect(status.installSource).toBe('native');
    expect(status.updateAvailable).toBe(true);
    expect(status.commands.update).toBe('/native/codex update');
    expect(status.actions).toMatchObject({ install: true, update: true, uninstall: false, reinstall: false });
  });
});

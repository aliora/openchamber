import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLatestVersionLookup, detectCliInstallation, isNewerVersion, CliInstaller, resolvePackageManager } from './cli-installer.js';
import { countTicksWhile, createFakeSpawn, flushMicrotasks } from './test/fake-cli.js';

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
    await installer.getStatus();
    await flush();
    const status = await installer.getStatus();
    expect(status.latestVersion).toBe('0.163.0');
    expect(status.updateAvailable).toBe(true);
  });

  it('offers no update for a CLI it cannot update', async () => {
    const installer = new CliInstaller(
      { packageName: '@anthropic-ai/claude-code', detect: () => ({ installed: true, version: '2.1.0' }) },
      { fetchLatest: async () => '2.2.0' },
    );
    await installer.getStatus();
    await flush();
    const status = await installer.getStatus();
    expect(status.latestVersion).toBe('2.2.0');
    expect(status.updateAvailable).toBe(false);
    expect(status.packageManager).toBeNull();
  });

  it('reports no update for a missing CLI', async () => {
    const installer = new CliInstaller(
      { packageName: '@openai/codex', detect: () => ({ installed: false, version: null }) },
      { fetchLatest: async () => '0.163.0' },
    );
    await installer.getStatus();
    await flush();
    expect((await installer.getStatus()).updateAvailable).toBe(false);
  });
});

describe('CliInstaller detection', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-10-20T08:00:00Z'));
  });

  afterEach(() => {
    setSystemTime();
  });

  const countingInstaller = (detection) => {
    const calls = { count: 0 };
    const installer = new CliInstaller({
      detect: async () => {
        calls.count += 1;
        return detection;
      },
    });
    return { installer, calls };
  };

  it('shares one detection between concurrent status reads', async () => {
    const { installer, calls } = countingInstaller({ installed: true, version: '1.0.0', command: '/bin/cli' });

    const [first, second] = await Promise.all([installer.getStatus(), installer.getStatus()]);

    expect(first.version).toBe('1.0.0');
    expect(second.version).toBe('1.0.0');
    expect(calls.count).toBe(1);
  });

  it('keeps a found CLI for 15 seconds', async () => {
    const { installer, calls } = countingInstaller({ installed: true, version: '1.0.0', command: '/bin/cli' });

    await installer.getStatus();
    setSystemTime(new Date('2026-10-20T08:00:14Z'));
    await installer.getStatus();
    expect(calls.count).toBe(1);

    setSystemTime(new Date('2026-10-20T08:00:16Z'));
    await installer.getStatus();
    expect(calls.count).toBe(2);
  });

  it('remembers a missing CLI for 5 seconds, then looks again', async () => {
    const { installer, calls } = countingInstaller({ installed: false, version: null, command: null });

    await installer.getStatus();
    setSystemTime(new Date('2026-10-20T08:00:04Z'));
    await installer.getStatus();
    expect(calls.count).toBe(1);

    setSystemTime(new Date('2026-10-20T08:00:06Z'));
    await installer.getStatus();
    expect(calls.count).toBe(2);
  });

  it('looks again when the caller forces it', async () => {
    const { installer, calls } = countingInstaller({ installed: false, version: null, command: null });

    await installer.getStatus();
    await installer.getStatus(true);

    expect(calls.count).toBe(2);
  });
});

describe('detectCliInstallation', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-detect-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks the CLI for its version without blocking the event loop', async () => {
    const command = path.join(dir, 'slow-cli');
    fs.writeFileSync(command, '#!/bin/sh\nsleep 0.3\necho "2.1.303 (Slow CLI)"\n', { mode: 0o755 });
    const spec = {
      packageName: 'slow-cli',
      productName: 'Slow CLI',
      resolveExecutable: async () => ({ command, isWindows: false }),
    };

    const { result, ticks } = await countTicksWhile(() => detectCliInstallation(spec, { platform: 'linux' }));

    expect(result).toMatchObject({ installed: true, version: '2.1.303', rawVersion: '2.1.303 (Slow CLI)', command });
    expect(ticks).toBeGreaterThan(5);
  });

  it('reports a CLI that exits with an error as not installed', async () => {
    const command = path.join(dir, 'broken-cli');
    fs.writeFileSync(command, '#!/bin/sh\necho broken >&2\nexit 2\n', { mode: 0o755 });
    const spec = { packageName: 'broken-cli', resolveExecutable: async () => ({ command, isWindows: false }) };

    await expect(detectCliInstallation(spec, { platform: 'linux' })).resolves.toMatchObject({ installed: false, exitCode: 2, stderr: 'broken' });
  });

  it('reports a missing executable as not installed', async () => {
    const spec = { packageName: 'missing-cli', resolveExecutable: async () => ({ command: 'oc-missing-cli-binary', isWindows: false }) };

    const result = await detectCliInstallation(spec, { platform: 'linux' });

    expect(result).toMatchObject({ installed: false, command: null });
    expect(result.error).toBeTruthy();
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

  it('offers every npm action with the command it runs', async () => {
    const status = await createInstaller().getStatus();
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

  it('offers only install for a missing CLI', async () => {
    detection = { installed: false, version: null, command: null };
    const status = await createInstaller().getStatus();
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
    await flushMicrotasks();
    expect(await installer.getStatus()).toMatchObject({ state: 'installing', action: 'update' });
    expect(spawn.calls[0]).toMatchObject({ command: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
    expect(spawn.calls[0].options.stdio[0]).toBe('ignore');
    spawn.finish(0, 'added 1 package\n');
    await running;

    expect(statuses).toEqual([['installing', 'update'], ['completed', 'update']]);
    expect(logs).toContain('added 1 package\n');
    expect(await installer.getStatus()).toMatchObject({ state: 'completed', action: 'update' });
  });

  it('runs one action at a time', async () => {
    const installer = createInstaller();
    const first = installer.runAction('doctor');
    await expect(installer.runAction('update')).rejects.toMatchObject({ code: 'busy' });
    await flushMicrotasks();
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
    await flushMicrotasks();
    spawn.finish(1);
    await expect(running).rejects.toThrow('npm install -g @openai/codex@latest --force exited with code 1');
    expect(await installer.getStatus()).toMatchObject({ state: 'failed', action: 'reinstall', lastError: expect.stringContaining('code 1') });
  });

  it('keeps the configuration on uninstall unless asked to remove it', async () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const installer = createInstaller();

    const kept = installer.runAction('uninstall');
    await flushMicrotasks();
    spawn.finish(0);
    await kept;
    expect(spawn.calls[0].args).toEqual(['uninstall', '-g', '@openai/codex']);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(true);

    const removed = installer.runAction('uninstall', { removeConfig: true });
    await flushMicrotasks();
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

  it('names a Homebrew installation and offers only the doctor', async () => {
    const cellar = path.join(home, 'Cellar', 'codex', '1.0.0');
    fs.mkdirSync(cellar, { recursive: true });
    fs.writeFileSync(path.join(cellar, 'codex'), '');
    detection = { installed: true, version: '1.0.0', command: path.join(cellar, 'codex') };
    const status = await createInstaller().getStatus();
    expect(status.installSource).toBe('brew');
    expect(status.actions).toEqual({ install: false, update: false, uninstall: false, reinstall: false, doctor: true });
    expect(status.commands.update).toBeNull();
  });

  it('tracks the latest version for a native installation', async () => {
    detection = { installed: true, version: '0.162.1', command: '/native/codex' };
    const installer = createInstaller({
      nativePlan: () => ({ update: [{ command: '/native/codex', args: ['update'] }], reinstall: null, uninstall: null }),
    });
    await installer.getStatus();
    await flushMicrotasks();
    const status = await installer.getStatus();
    expect(status.installSource).toBe('native');
    expect(status.updateAvailable).toBe(true);
    expect(status.commands.update).toBe('/native/codex update');
    expect(status.actions).toMatchObject({ install: true, update: true, uninstall: false, reinstall: false });
  });
});

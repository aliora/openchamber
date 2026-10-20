import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectClaudeInstallation,
  resolvePackageManager,
  ClaudeInstaller,
  OFFICIAL_PACKAGE_NAME,
} from './installer.js';
import { createFakeSpawn, flushMicrotasks } from '../test/fake-cli.js';

describe('ClaudeInstaller', () => {
  it('has official package name set to @anthropic-ai/claude-code', () => {
    expect(OFFICIAL_PACKAGE_NAME).toBe('@anthropic-ai/claude-code');
  });

  describe('detectClaudeInstallation', () => {
    it('detects current system installation if present', async () => {
      const result = await detectClaudeInstallation();
      expect([true, false]).toContain(result.installed);
      if (result.installed) {
        expect(result.version).toMatch(/\d/);
        expect(result.command.length).toBeGreaterThan(0);
      }
    });

    it('handles non-existent command path gracefully', async () => {
      const result = await detectClaudeInstallation({
        env: {
          APPDATA: 'C:\\non-existent-appdata',
          LOCALAPPDATA: 'C:\\non-existent-local',
          PATH: '',
        },
      });
      expect([true, false]).toContain(result.installed);
    });
  });

  describe('resolvePackageManager', () => {
    it('resolves npm.cmd on win32 platform', () => {
      const pm = resolvePackageManager({ platform: 'win32' });
      expect(pm.manager).toBe('npm');
      expect(pm.isWindows).toBe(true);
      expect(pm.command.toLowerCase()).toContain('npm.cmd');
    });

    it('resolves unix npm on linux platform', () => {
      const pm = resolvePackageManager({
        platform: 'linux',
        env: { HOME: '/tmp/test-home' },
        fileExists: () => false,
      });
      expect(pm.manager).toBe('npm');
      expect(pm.isWindows).toBe(false);
      expect(pm.command).toBe('npm');
    });

    it('resolves unix npm on darwin platform', () => {
      const pm = resolvePackageManager({
        platform: 'darwin',
        env: { HOME: '/tmp/test-home' },
        fileExists: () => false,
      });
      expect(pm.manager).toBe('npm');
      expect(pm.isWindows).toBe(false);
      expect(pm.command).toBe('npm');
    });

    it('prefers an npm binary found at a known unix location', () => {
      const pm = resolvePackageManager({
        platform: 'linux',
        env: { HOME: '/tmp/test-home' },
        fileExists: (loc) => loc === '/tmp/test-home/.npm-global/bin/npm',
      });
      expect(pm.command).toBe('/tmp/test-home/.npm-global/bin/npm');
    });
  });

  describe('ClaudeInstaller instance & event lifecycle', () => {
    it('initializes with idle state and provides valid status', async () => {
      const installer = new ClaudeInstaller();
      const status = await installer.getStatus();

      expect(status.state).toBe('idle');
      expect([true, false]).toContain(status.installed);
      expect(status.canInstall).toBe(true);
      expect(status.packageManagerCommand).toContain('npm');
    });

    it('appends and emits log events', () => {
      const installer = new ClaudeInstaller();
      const receivedLogs = [];
      installer.on('log', (entry) => receivedLogs.push(entry));

      installer._appendLog('stdout', 'Installing package...\n');
      installer._appendLog('stderr', 'Warn: peer dependency\n');

      expect(receivedLogs.map((log) => [log.stream, log.text])).toEqual([
        ['stdout', 'Installing package...\n'],
        ['stderr', 'Warn: peer dependency\n'],
      ]);
      expect(installer.getLogs().length).toBe(2);
    });
  });
});

describe('ClaudeInstaller native installation', () => {
  let home;
  let link;
  let dataDir;
  let spawn;

  const createInstaller = () => new ClaudeInstaller({
    platform: 'darwin',
    env: { HOME: home },
    home,
    spawnProcess: spawn.spawnProcess,
    fetchLatest: async () => '2.1.301',
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claude-native-'));
    dataDir = path.join(home, '.local', 'share', 'claude');
    fs.mkdirSync(path.join(dataDir, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'versions', '2.1.300'), '');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    link = path.join(home, '.local', 'bin', 'claude');
    fs.symlinkSync(path.join(dataDir, 'versions', '2.1.300'), link);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    spawn = createFakeSpawn();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const withDetection = (installer, command = link) => {
    installer.detect = () => ({ installed: true, version: '2.1.300', command });
    return installer;
  };

  it('updates and reinstalls with the CLI and removes only its own folders', async () => {
    const status = await withDetection(createInstaller()).getStatus();
    expect(status.installSource).toBe('native');
    expect(status.actions).toEqual({ install: true, update: true, uninstall: true, reinstall: true, doctor: true });
    expect(status.commands).toEqual({
      install: `${link} update`,
      update: `${link} update`,
      uninstall: `rm -rf ${link} ${dataDir}`,
      reinstall: `${link} install latest --force`,
      doctor: `${link} doctor`,
    });
    expect(status.packageManager).toBeNull();
  });

  it('runs claude update for an update', async () => {
    const installer = withDetection(createInstaller());
    const running = installer.runAction('update');
    await flushMicrotasks();
    expect(spawn.calls[0]).toMatchObject({ command: link, args: ['update'] });
    spawn.finish(0);
    await running;
  });

  it('uninstalls the link and versions and keeps the configuration by default', async () => {
    const installer = withDetection(createInstaller());
    await installer.runAction('uninstall');
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(true);
    expect(spawn.calls).toHaveLength(0);
  });

  it('removes the configuration only when asked', async () => {
    await withDetection(createInstaller()).runAction('uninstall', { removeConfig: true });
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('offers no native action for a link that points outside its versions folder', async () => {
    const elsewhere = path.join(home, 'elsewhere');
    fs.writeFileSync(elsewhere, '');
    fs.rmSync(link);
    fs.symlinkSync(elsewhere, link);
    const status = await withDetection(createInstaller()).getStatus();
    expect(status.installSource).toBe('unknown');
    expect(status.actions).toMatchObject({ update: false, uninstall: false, reinstall: false });
  });

  it('offers no native action for a claude found anywhere else', async () => {
    const status = await withDetection(createInstaller(), '/usr/local/bin/claude').getStatus();
    expect(status.actions.uninstall).toBe(false);
  });
});

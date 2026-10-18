import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityInstaller, detectAgyInstallation, installCommandFor } from './installer.js';
import { createFakeSpawn } from '../test/fake-cli.js';

const versionProbe = (result) => () => ({ status: 0, stdout: '', stderr: '', error: undefined, ...result });

describe('detectAgyInstallation', () => {
  it('reads the version agy prints', () => {
    const detection = detectAgyInstallation({
      resolveCommand: () => '/home/dev/.local/bin/agy',
      runVersion: versionProbe({ stdout: 'agy 1.4.0\n' }),
    });
    expect(detection).toEqual({ installed: true, version: '1.4.0', rawVersion: 'agy 1.4.0', command: '/home/dev/.local/bin/agy' });
  });

  it('reports a missing or broken binary as not installed', () => {
    const missing = detectAgyInstallation({
      resolveCommand: () => 'agy',
      runVersion: versionProbe({ status: null, error: new Error('spawnSync agy ENOENT') }),
    });
    expect(missing).toMatchObject({ installed: false, command: null, error: 'spawnSync agy ENOENT' });

    const broken = detectAgyInstallation({ resolveCommand: () => 'agy', runVersion: versionProbe({ status: 2 }) });
    expect(broken).toMatchObject({ installed: false, error: 'agy --version exited with code 2' });
  });
});

describe('AntigravityInstaller', () => {
  it('installs with the official install script', async () => {
    const spawn = createFakeSpawn();
    const installer = new AntigravityInstaller({ platform: 'linux', detect: () => ({ installed: false, version: null, command: null }), spawnProcess: spawn.spawnProcess });
    const status = installer.getStatus();
    expect(status).toMatchObject({
      state: 'idle',
      installed: false,
      canInstall: true,
      installSource: 'unknown',
      latestVersion: null,
      packageManager: null,
      installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    });
    expect(status.actions).toEqual({ install: true, update: false, uninstall: false, reinstall: false, doctor: false });

    const running = installer.install();
    expect(spawn.calls[0]).toMatchObject({ command: '/bin/bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] });
    spawn.finish(0);
    await running;
    expect(installer.getStatus()).toMatchObject({ state: 'completed', action: 'install' });
  });

  it('names the PowerShell installer on Windows', () => {
    expect(installCommandFor('win32')).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(installCommandFor('darwin')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
  });

  it('caches a found binary and looks again for a missing one', () => {
    const detections = [];
    const installed = new AntigravityInstaller({
      detect: () => {
        detections.push('installed');
        return { installed: true, version: '1.4.0', command: '/usr/local/bin/agy' };
      },
    });
    installed.getStatus();
    installed.getStatus();
    expect(detections).toHaveLength(1);
    installed.getStatus(true);
    expect(detections).toHaveLength(2);

    let missingChecks = 0;
    const missing = new AntigravityInstaller({
      detect: () => {
        missingChecks += 1;
        return { installed: false, version: null, command: null };
      },
    });
    missing.getStatus();
    missing.getStatus();
    expect(missingChecks).toBe(2);
  });
});

describe('AntigravityInstaller native installation', () => {
  let home;
  let binary;
  let spawn;

  const createInstaller = (command = binary) => new AntigravityInstaller({
    platform: 'darwin',
    env: { HOME: home },
    home,
    detect: () => ({ installed: true, version: '1.4.0', command }),
    spawnProcess: spawn.spawnProcess,
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-agy-native-'));
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    binary = path.join(home, '.local', 'bin', 'agy');
    fs.writeFileSync(binary, '');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    spawn = createFakeSpawn();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('updates with agy update, reinstalls with the script and has no doctor', () => {
    const status = createInstaller().getStatus();
    expect(status.installSource).toBe('native');
    expect(status.actions).toEqual({ install: true, update: true, uninstall: true, reinstall: true, doctor: false });
    expect(status.commands).toEqual({
      install: `${binary} update`,
      update: `${binary} update`,
      uninstall: `rm -rf ${binary}`,
      reinstall: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      doctor: null,
    });
    expect(status.updateAvailable).toBe(false);
  });

  it('removes the binary and keeps its settings unless asked', async () => {
    await createInstaller().runAction('uninstall');
    expect(fs.existsSync(binary)).toBe(false);
    expect(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))).toBe(true);

    fs.writeFileSync(binary, '');
    await createInstaller().runAction('uninstall', { removeConfig: true });
    expect(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(true);
  });

  it('offers no native action for a binary that is a link or somewhere else', () => {
    fs.rmSync(binary);
    fs.symlinkSync('/usr/bin/true', binary);
    expect(createInstaller().getStatus().actions.uninstall).toBe(false);
    expect(createInstaller('/usr/local/bin/agy').getStatus().actions.uninstall).toBe(false);
  });
});

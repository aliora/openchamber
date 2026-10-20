import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityInstaller, detectAgyInstallation, installCommandFor } from './installer.js';
import { createFakeSpawn, flushMicrotasks } from '../test/fake-cli.js';

const versionProbe = (result) => async () => ({ code: 0, stdout: '', stderr: '', error: null, ...result });

describe('detectAgyInstallation', () => {
  it('reads the version agy prints', async () => {
    const detection = await detectAgyInstallation({
      resolveCommand: async () => '/home/dev/.local/bin/agy',
      runVersion: versionProbe({ stdout: 'agy 1.4.0\n' }),
    });
    expect(detection).toEqual({ installed: true, version: '1.4.0', rawVersion: 'agy 1.4.0', command: '/home/dev/.local/bin/agy' });
  });

  it('reports a missing or broken binary as not installed', async () => {
    const missing = await detectAgyInstallation({
      resolveCommand: async () => 'agy',
      runVersion: versionProbe({ code: null, error: 'spawn agy ENOENT' }),
    });
    expect(missing).toMatchObject({ installed: false, command: null, error: 'spawn agy ENOENT' });

    const broken = await detectAgyInstallation({ resolveCommand: async () => 'agy', runVersion: versionProbe({ code: 2 }) });
    expect(broken).toMatchObject({ installed: false, error: 'agy --version exited with code 2' });
  });
});

describe('AntigravityInstaller', () => {
  it('installs with the official install script', async () => {
    const spawn = createFakeSpawn();
    const installer = new AntigravityInstaller({ platform: 'linux', detect: () => ({ installed: false, version: null, command: null }), spawnProcess: spawn.spawnProcess });
    const status = await installer.getStatus();
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
    await flushMicrotasks();
    expect(spawn.calls[0]).toMatchObject({ command: '/bin/bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] });
    spawn.finish(0);
    await running;
    expect(await installer.getStatus()).toMatchObject({ state: 'completed', action: 'install' });
  });

  it('names the PowerShell installer on Windows', () => {
    expect(installCommandFor('win32')).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(installCommandFor('darwin')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
  });

  it('caches a found binary and briefly a missing one', async () => {
    const detections = [];
    const installed = new AntigravityInstaller({
      detect: () => {
        detections.push('installed');
        return { installed: true, version: '1.4.0', command: '/usr/local/bin/agy' };
      },
    });
    await installed.getStatus();
    await installed.getStatus();
    expect(detections).toHaveLength(1);
    await installed.getStatus(true);
    expect(detections).toHaveLength(2);

    let missingChecks = 0;
    const missing = new AntigravityInstaller({
      detect: () => {
        missingChecks += 1;
        return { installed: false, version: null, command: null };
      },
    });
    await missing.getStatus();
    await missing.getStatus();
    expect(missingChecks).toBe(1);
    await missing.getStatus(true);
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

  it('updates with agy update, reinstalls with the script and has no doctor', async () => {
    const status = await createInstaller().getStatus();
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

  it('offers no native action for a binary that is a link or somewhere else', async () => {
    fs.rmSync(binary);
    fs.symlinkSync('/usr/bin/true', binary);
    expect((await createInstaller().getStatus()).actions.uninstall).toBe(false);
    expect((await createInstaller('/usr/local/bin/agy').getStatus()).actions.uninstall).toBe(false);
  });
});

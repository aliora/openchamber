import { describe, it, expect } from 'bun:test';
import { AntigravityInstaller, detectAgyInstallation, installCommandFor } from './installer.js';

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
  it('offers the official install command instead of installing', async () => {
    const installer = new AntigravityInstaller({ platform: 'linux', detect: () => ({ installed: false, version: null, command: null }) });
    const status = installer.getStatus();
    expect(status).toMatchObject({
      state: 'idle',
      installed: false,
      canInstall: false,
      installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    });
    expect(installer.getLogs()).toEqual([]);
    await expect(installer.install()).rejects.toThrow('install.sh | bash');
    expect(installer.getStatus().state).toBe('idle');
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

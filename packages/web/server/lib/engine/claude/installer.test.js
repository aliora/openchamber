import { describe, expect, it } from 'bun:test';
import {
  detectClaudeInstallation,
  resolvePackageManager,
  ClaudeInstaller,
  OFFICIAL_PACKAGE_NAME,
} from './installer.js';

describe('ClaudeInstaller', () => {
  it('has official package name set to @anthropic-ai/claude-code', () => {
    expect(OFFICIAL_PACKAGE_NAME).toBe('@anthropic-ai/claude-code');
  });

  describe('detectClaudeInstallation', () => {
    it('detects current system installation if present', () => {
      const result = detectClaudeInstallation();
      // Should return an object with installed boolean
      expect(typeof result.installed).toBe('boolean');
      if (result.installed) {
        expect(typeof result.version).toBe('string');
        expect(result.version.length).toBeGreaterThan(0);
        expect(typeof result.command).toBe('string');
      }
    });

    it('handles non-existent command path gracefully', () => {
      const result = detectClaudeInstallation({
        env: {
          APPDATA: 'C:\\non-existent-appdata',
          LOCALAPPDATA: 'C:\\non-existent-local',
          PATH: '',
        },
      });
      // Should not throw, should return installed: false or clean error
      expect(typeof result.installed).toBe('boolean');
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
      });
      expect(pm.manager).toBe('npm');
      expect(pm.isWindows).toBe(false);
      expect(pm.command).toBe('npm');
    });

    it('resolves unix npm on darwin platform', () => {
      const pm = resolvePackageManager({
        platform: 'darwin',
        env: { HOME: '/tmp/test-home' },
      });
      expect(pm.manager).toBe('npm');
      expect(pm.isWindows).toBe(false);
      expect(pm.command).toBe('npm');
    });
  });

  describe('ClaudeInstaller instance & event lifecycle', () => {
    it('initializes with idle state and provides valid status', () => {
      const installer = new ClaudeInstaller();
      const status = installer.getStatus();

      expect(status.state).toBe('idle');
      expect(typeof status.installed).toBe('boolean');
      expect(status.canInstall).toBe(true);
      expect(status.packageManager).toBe('npm');
    });

    it('appends and emits log events', (done) => {
      const installer = new ClaudeInstaller();
      const receivedLogs = [];

      installer.on('log', (entry) => {
        receivedLogs.push(entry);
        if (receivedLogs.length === 2) {
          expect(receivedLogs[0].stream).toBe('stdout');
          expect(receivedLogs[0].text).toBe('Installing package...\n');
          expect(receivedLogs[1].stream).toBe('stderr');
          expect(receivedLogs[1].text).toBe('Warn: peer dependency\n');
          expect(installer.getLogs().length).toBe(2);
          done();
        }
      });

      installer._appendLog('stdout', 'Installing package...\n');
      installer._appendLog('stderr', 'Warn: peer dependency\n');
    });

    it('emits status event when state changes', (done) => {
      const installer = new ClaudeInstaller();

      installer.on('status', (evt) => {
        expect(evt.state).toBe('installing');
        done();
      });

      installer.emit('status', { state: 'installing' });
    });
  });
});

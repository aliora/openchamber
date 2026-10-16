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
      expect([true, false]).toContain(result.installed);
      if (result.installed) {
        expect(result.version).toMatch(/\d/);
        expect(result.command.length).toBeGreaterThan(0);
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
    it('initializes with idle state and provides valid status', () => {
      const installer = new ClaudeInstaller();
      const status = installer.getStatus();

      expect(status.state).toBe('idle');
      expect([true, false]).toContain(status.installed);
      expect(status.canInstall).toBe(true);
      expect(status.packageManager).toBe('npm');
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

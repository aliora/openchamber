import { describe, expect, it } from 'bun:test';
import { createLatestVersionLookup, isNewerVersion, CliInstaller } from './cli-installer.js';

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

  it('offers no update for a CLI that npm does not manage', async () => {
    const installer = new CliInstaller(
      { packageName: '@anthropic-ai/claude-code', detect: () => ({ installed: true, version: '2.1.0' }) },
      { fetchLatest: async () => '2.2.0' },
    );
    installer.getStatus();
    await flush();
    const status = installer.getStatus();
    expect(status.latestVersion).toBe('2.2.0');
    expect(status.updateAvailable).toBe(false);
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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExecutable } from './platform.js';

describe('resolveCodexExecutable', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codex-bin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers the npm launcher in %APPDATA%\\npm on Windows', () => {
    fs.mkdirSync(path.join(tmpDir, 'npm'));
    fs.writeFileSync(path.join(tmpDir, 'npm', 'codex.cmd'), '@echo off\n');

    expect(resolveCodexExecutable({ platform: 'win32', env: { APPDATA: tmpDir } }))
      .toEqual({ command: path.join(tmpDir, 'npm', 'codex.cmd'), isWindows: true });
  });

  it('falls back to the codex.cmd name on Windows when nothing is found', () => {
    const resolved = resolveCodexExecutable({ platform: 'win32', env: { APPDATA: path.join(tmpDir, 'missing') } });
    expect(resolved.isWindows).toBe(true);
    expect(resolved.command.toLowerCase()).toMatch(/codex(\.(cmd|exe))?$/);
  });

  it('resolves a codex command on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux']) {
      const resolved = resolveCodexExecutable({ platform, env: { HOME: tmpDir, PATH: process.env.PATH, SHELL: '/bin/sh' } });
      expect(resolved.isWindows).toBe(false);
      expect(resolved.command).toMatch(/codex$/);
    }
  });

  it('finds codex in ~/.local/bin', () => {
    fs.mkdirSync(path.join(tmpDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.local', 'bin', 'codex'), '');
    const systemWide = ['/usr/local/bin/codex', '/opt/homebrew/bin/codex', '/usr/bin/codex'].find((p) => fs.existsSync(p));

    const resolved = resolveCodexExecutable({ platform: 'linux', env: { HOME: tmpDir } });
    expect(resolved.command).toBe(systemWide || path.join(tmpDir, '.local', 'bin', 'codex'));
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliNeedsShell, resolveCliExecutableAsync, runCli, shellCommand } from './cli-platform.js';
import { countTicksWhile } from './test/fake-cli.js';

const node = { command: process.execPath, isWindows: false };

describe('cli-platform', () => {
  it('runs a .cmd or .bat wrapper through the shell only on Windows', () => {
    expect(cliNeedsShell({ command: 'C:\\npm\\codex.cmd', isWindows: true })).toBe(true);
    expect(cliNeedsShell({ command: 'C:\\npm\\codex.bat', isWindows: true })).toBe(true);
    expect(cliNeedsShell({ command: 'C:\\bin\\codex.exe', isWindows: true })).toBe(false);
    expect(cliNeedsShell({ command: '/usr/local/bin/codex', isWindows: false })).toBe(false);
  });

  it('quotes a shell command whose path has spaces', () => {
    expect(shellCommand('C:\\Program Files\\nodejs\\npm.cmd', true)).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(shellCommand('C:\\npm\\codex.cmd', true)).toBe('C:\\npm\\codex.cmd');
    expect(shellCommand('/Users/a b/bin/codex', false)).toBe('/Users/a b/bin/codex');
  });

  it('collects the exit code and both output streams of a short command', async () => {
    const result = await runCli(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err', error: null });
  });

  it('resolves instead of rejecting when the binary is missing', async () => {
    const result = await runCli({ command: '/nonexistent/codex', isWindows: false }, ['login', 'status']);
    expect(result.code).toBeNull();
    expect(result.error).toContain('ENOENT');
  });

  it('stops a command that runs past its timeout', async () => {
    const result = await runCli(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 });
    expect(result).toMatchObject({ code: null, error: 'timed out' });
  });
});

describe('resolveCliExecutableAsync', () => {
  let dir;
  const spec = (binary) => ({ binary, windowsCandidates: () => [], unixCandidates: () => [] });
  const writeScript = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks the login shell without blocking the event loop', async () => {
    const binary = writeScript('found-cli', 'exit 0');
    const shell = writeScript('slow-shell', `sleep 0.3\necho ${binary}`);

    const { result, ticks } = await countTicksWhile(() => resolveCliExecutableAsync(spec('found-cli'), { platform: 'darwin', env: { SHELL: shell } }));

    expect(result).toEqual({ command: binary, isWindows: false });
    expect(ticks).toBeGreaterThan(5);
  });

  it('prefers a known install path over the login shell', async () => {
    const binary = writeScript('known-cli', 'exit 0');
    const shell = writeScript('failing-shell', 'exit 1');
    const known = { binary: 'known-cli', windowsCandidates: () => [], unixCandidates: () => [binary] };

    await expect(resolveCliExecutableAsync(known, { platform: 'linux', env: { SHELL: shell } })).resolves.toEqual({ command: binary, isWindows: false });
  });

  it('falls back to the bare name when the login shell finds nothing', async () => {
    const shell = writeScript('empty-shell', 'exit 1');

    await expect(resolveCliExecutableAsync(spec('missing-cli'), { platform: 'linux', env: { SHELL: shell } })).resolves.toEqual({ command: 'missing-cli', isWindows: false });
  });
});

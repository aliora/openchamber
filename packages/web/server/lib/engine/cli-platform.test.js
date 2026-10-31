import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cliNeedsShell, resolveCliExecutableAsync, runCli, shellCommand, terminateChildTree } from './cli-platform.js';
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

describe.skipIf(process.platform === 'win32')('terminateChildTree', () => {
  const isRunning = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('stops a command the CLI started in a process group of its own', async () => {
    const grandchildScript = "setInterval(() => {}, 1000)";
    const childScript = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore' });
      console.log(grandchild.pid);
      process.on('SIGINT', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchildPid = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(Number(chunk.toString()))));
    expect(isRunning(grandchildPid)).toBe(true);

    await terminateChildTree(child);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(child.exitCode).toBe(0);
    expect(isRunning(grandchildPid)).toBe(false);
  });

  it('leaves alone a process that is no longer below the stopped CLI', async () => {
    const killed = [];
    const child = spawn(process.execPath, ['-e', "process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    const tables = [
      new Map([[child.pid, process.pid], [9001, child.pid], [9002, child.pid]]),
      new Map([[9001, 1], [9002, 4242]]),
    ];

    await terminateChildTree(child, { readParents: () => tables.shift(), kill: (pid) => killed.push(pid) });

    expect(killed).toEqual([9001]);
  });
});

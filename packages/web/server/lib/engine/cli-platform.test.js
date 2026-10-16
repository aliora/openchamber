import { describe, expect, it } from 'bun:test';
import { cliNeedsShell, runCli } from './cli-platform.js';

const node = { command: process.execPath, isWindows: false };

describe('cli-platform', () => {
  it('runs a .cmd or .bat wrapper through the shell only on Windows', () => {
    expect(cliNeedsShell({ command: 'C:\\npm\\codex.cmd', isWindows: true })).toBe(true);
    expect(cliNeedsShell({ command: 'C:\\npm\\codex.bat', isWindows: true })).toBe(true);
    expect(cliNeedsShell({ command: 'C:\\bin\\codex.exe', isWindows: true })).toBe(false);
    expect(cliNeedsShell({ command: '/usr/local/bin/codex', isWindows: false })).toBe(false);
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

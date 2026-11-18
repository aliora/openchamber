import { describe, expect, it, vi } from 'vitest';

import { armWindowsExitWatchdog } from './exit-watchdog.js';

describe('armWindowsExitWatchdog', () => {
  it('does nothing outside Windows', () => {
    const spawnProcess = vi.fn();
    expect(armWindowsExitWatchdog({ platform: 'linux', pid: 1234, spawnProcess })).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('refuses invalid pids', () => {
    const spawnProcess = vi.fn();
    expect(armWindowsExitWatchdog({ platform: 'win32', pid: 1, spawnProcess })).toBe(false);
    expect(armWindowsExitWatchdog({ platform: 'win32', pid: Number.NaN, spawnProcess })).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('spawns a hidden watcher that waits on the pid, then ends children and the process', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnProcess = vi.fn(() => child);
    expect(armWindowsExitWatchdog({ platform: 'win32', pid: 4321, timeoutMs: 15000, spawnProcess, systemRoot: 'C:\\WINDOWS' })).toBe(true);
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(options).toMatchObject({ detached: false, stdio: 'ignore', windowsHide: true });
    expect(args.at(-2)).toBe('-EncodedCommand');
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    expect(script).toContain('Get-Process -Id 4321');
    expect(script).toContain('WaitForExit(15000)');
    expect(script).toContain('ParentProcessId=4321');
    expect(script).toContain("C:\\WINDOWS\\System32\\taskkill.exe' /T /F /PID");
    expect(script).toContain('$p.Kill()');
    expect(child.unref).toHaveBeenCalled();
  });

  it('never throws when spawning fails', () => {
    const spawnProcess = vi.fn(() => { throw new Error('ENOENT'); });
    expect(armWindowsExitWatchdog({ platform: 'win32', pid: 4321, spawnProcess })).toBe(false);
  });
});

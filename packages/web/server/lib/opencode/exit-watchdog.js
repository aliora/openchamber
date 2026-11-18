import { spawn } from 'node:child_process';

/**
 * Windows only: a process.exit() can block in native teardown — a ConPTY terminal left open
 * waits in ClosePseudoConsole on the main thread — so the server logs "Graceful shutdown complete"
 * and never exits, and the supervisor loop that would restart it waits forever.
 *
 * Arm right before process.exit(): a hidden, unref'd PowerShell opens a handle to this process
 * (no pid reuse: it acts on that handle) and, if it is still alive after `timeoutMs`, force-ends
 * its child trees (terminals, engine CLIs) and then the process itself. A clean exit makes the
 * watcher return at once. Never throws.
 */
export const armWindowsExitWatchdog = ({
  platform = process.platform,
  pid = process.pid,
  timeoutMs = 15000,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot,
} = {}) => {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  const wait = Math.max(1000, Math.floor(timeoutMs));
  const taskkill = `${systemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if (-not $p -or $p.WaitForExit(${wait})) { exit 0 }`,
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { & '${taskkill}' /T /F /PID $_.ProcessId | Out-Null }`,
    'if (-not $p.HasExited) { $p.Kill() }',
  ].join('; ');
  try {
    // -EncodedCommand: no Windows argument quoting can reach the script's own quotes.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      // Not `detached`: Windows PowerShell started as DETACHED_PROCESS has no console and quits at
      // once. A Windows child outlives its parent anyway; the script skips its own pid.
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child?.on?.('error', () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
};

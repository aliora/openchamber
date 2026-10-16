import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveAgyExecutable } from './platform.js';

// Antigravity CLI is not an npm package. Google ships it through an install
// script that downloads a native binary. The server does not pipe that script
// into a shell on its own: `canInstall` is false and `installCommand` carries
// the official command for the user to run.

const INSTALL_COMMANDS = {
  posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  win32: 'irm https://antigravity.google/cli/install.ps1 | iex',
};

export const installCommandFor = (platform) => (platform === 'win32' ? INSTALL_COMMANDS.win32 : INSTALL_COMMANDS.posix);

const probeVersion = (command) => spawnSync(command, ['--version'], {
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

export const detectAgyInstallation = ({
  resolveCommand = () => resolveAgyExecutable().command,
  runVersion = probeVersion,
} = {}) => {
  const command = resolveCommand();
  const res = runVersion(command);
  if (res.error) {
    return { installed: false, version: null, command: null, error: res.error.message };
  }
  const output = (res.stdout || '').trim();
  if (res.status !== 0 || !output) {
    return { installed: false, version: null, command: null, error: `agy --version exited with code ${res.status}` };
  }
  const version = output.match(/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?/)?.[0] || output.split(/\s+/)[0];
  return { installed: true, version, rawVersion: output, command };
};

/** Same interface as ClaudeInstaller; `install()` always rejects with the manual step. */
export class AntigravityInstaller extends EventEmitter {
  constructor({ platform = process.platform, detect = detectAgyInstallation } = {}) {
    super();
    this.platform = platform;
    this.detect = detect;
    this.cachedDetection = null;
    this.cachedAt = 0;
  }

  getStatus(forceRefresh = false) {
    const fresh = this.cachedDetection?.installed && Date.now() - this.cachedAt < 15000;
    if (forceRefresh || !fresh) {
      this.cachedDetection = this.detect();
      this.cachedAt = Date.now();
    }
    const detection = this.cachedDetection;
    return {
      state: 'idle',
      installed: detection.installed,
      version: detection.version,
      rawVersion: detection.rawVersion,
      command: detection.command,
      packageManager: null,
      packageManagerCommand: null,
      canInstall: false,
      installCommand: installCommandFor(this.platform),
      logsCount: 0,
      lastError: detection.error || null,
      detection,
    };
  }

  getLogs() {
    return [];
  }

  install() {
    return Promise.reject(new Error(`Install Antigravity CLI from a terminal: ${installCommandFor(this.platform)}`));
  }
}

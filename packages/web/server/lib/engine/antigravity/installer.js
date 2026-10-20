import fs from 'node:fs';
import path from 'node:path';
import { CliInstaller, scriptStep } from '../cli-installer.js';
import { runCli } from '../cli-platform.js';
import { resolveAgyExecutableAsync } from './platform.js';

// Antigravity CLI is not an npm package. Google ships it through an install
// script that downloads a native binary, which the server runs for install
// and reinstall.

const INSTALL_COMMANDS = {
  posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  win32: 'irm https://antigravity.google/cli/install.ps1 | iex',
};

export const installCommandFor = (platform) => (platform === 'win32' ? INSTALL_COMMANDS.win32 : INSTALL_COMMANDS.posix);

const probeVersion = (command) => runCli({ command, isWindows: false }, ['--version'], { timeoutMs: 10000 });

export const detectAgyInstallation = async ({
  resolveCommand = async () => (await resolveAgyExecutableAsync()).command,
  runVersion = probeVersion,
} = {}) => {
  const command = await resolveCommand();
  const res = await runVersion(command);
  if (res.error) {
    return { installed: false, version: null, command: null, error: res.error };
  }
  const output = res.stdout.trim();
  if (res.code !== 0 || !output) {
    return { installed: false, version: null, command: null, error: `agy --version exited with code ${res.code}` };
  }
  const version = output.match(/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?/)?.[0] || output.split(/\s+/)[0];
  return { installed: true, version, rawVersion: output, command };
};

/**
 * The install script's steps when `agy` is the binary it puts in
 * ~/.local/bin, and `null` for any other installation or on Windows.
 */
export const agyNativePlan = ({ detection, home, platform, installScript }) => {
  const binary = path.join(home, '.local', 'bin', 'agy');
  if (platform === 'win32' || detection.command !== binary) return null;
  try {
    if (!fs.lstatSync(binary).isFile()) return null;
  } catch {
    return null;
  }
  return {
    update: [{ command: binary, args: ['update'] }],
    reinstall: [scriptStep(installScript, platform)],
    uninstall: [{ remove: [binary] }],
  };
};

/** Installs Antigravity CLI with its install script, updates it with `agy update` and removes its binary. */
export class AntigravityInstaller extends CliInstaller {
  constructor({ detect = detectAgyInstallation, ...options } = {}) {
    super({
      detect,
      nativePlan: agyNativePlan,
      installScript: installCommandFor(options.platform || process.platform),
      configPaths: (home) => [path.join(home, '.gemini', 'antigravity-cli')],
    }, options);
  }
}

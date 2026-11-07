import path from 'node:path';
import { CliInstaller, detectCliInstallation } from '../cli-installer.js';
import { cliNeedsShell, runCli } from '../cli-platform.js';
import { resolveOpenCodeExecutable } from './platform.js';

const OFFICIAL_PACKAGE_NAME = '@opencode/cli';

const UNSUPPORTED_VERSION = 'This engine requires OpenCode 2.0.29 or newer within 2.x.';

const isSupportedVersion = (version) => {
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 2 && !(minor === 0 && patch < 29);
};

export const inspectOpenCodeExecutable = async ({ env, resolveExecutable = () => resolveOpenCodeExecutable({ env }), run = runCli } = {}) => {
  const resolved = await resolveExecutable();
  const result = await run(resolved, ['--version'], { timeoutMs: 5000 });
  const version = result.stdout.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
  if (result.code !== 0 || !version) throw new Error('Could not read the OpenCode CLI version.');
  if (!isSupportedVersion(version)) throw new Error(UNSUPPORTED_VERSION);
  return { ...resolved, version };
};

/** Whether a compatible OpenCode CLI is installed, with its version and command path. */
const detectOpenCodeInstallation = async (options = {}) => {
  const detection = await detectCliInstallation({
    packageName: OFFICIAL_PACKAGE_NAME,
    productName: 'OpenCode',
    resolveExecutable: ({ platform, env }) => resolveOpenCodeExecutable({ env, platform }),
  }, options);
  return detection.installed && !isSupportedVersion(detection.version)
    ? { ...detection, installed: false, error: UNSUPPORTED_VERSION }
    : detection;
};

/**
 * The CLI's own `upgrade` and `uninstall` when `opencode` sits in the
 * `~/.opencode/bin` folder its installer uses, and `null` for any other place.
 */
export const openCodeNativePlan = ({ detection, home }) => {
  if (path.resolve(path.dirname(detection.command)) !== path.resolve(home, '.opencode', 'bin')) return null;
  const run = (args) => [{ command: detection.command, args, shell: cliNeedsShell(detection) }];
  return { update: run(['upgrade']), reinstall: run(['upgrade']), uninstall: run(['uninstall', '--force']) };
};

/** Installs, updates and removes the OpenCode CLI from npm or its own installer and streams the output. */
export class OpenCodeInstaller extends CliInstaller {
  constructor({ getEnvironment = () => process.env, ...options } = {}) {
    super({
      packageName: OFFICIAL_PACKAGE_NAME,
      detect: async (detectOptions) => detectOpenCodeInstallation({ ...detectOptions, env: await getEnvironment() }),
      nativePlan: openCodeNativePlan,
    }, options);
  }
}

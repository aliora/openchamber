import fs from 'node:fs';
import path from 'node:path';
import { CliInstaller, detectCliInstallation, isInsideDirectory } from '../cli-installer.js';
import { resolveClaudeExecutableAsync } from './platform.js';

export { resolvePackageManager } from '../cli-installer.js';

export const OFFICIAL_PACKAGE_NAME = '@anthropic-ai/claude-code';

/** Whether Claude Code is installed, with its version and command path. */
export const detectClaudeInstallation = (options = {}) => detectCliInstallation({
  packageName: OFFICIAL_PACKAGE_NAME,
  productName: 'Claude Code',
  resolveExecutable: resolveClaudeExecutableAsync,
}, options);

/**
 * The native installer's steps when `claude` is its link in ~/.local/bin
 * pointing into ~/.local/share/claude, and `null` for any other installation.
 */
export const claudeNativePlan = ({ detection, home }) => {
  const link = path.join(home, '.local', 'bin', 'claude');
  const dataDir = path.join(home, '.local', 'share', 'claude');
  if (detection.command !== link) return null;
  try {
    if (!fs.lstatSync(link).isSymbolicLink() || !fs.lstatSync(dataDir).isDirectory()) return null;
    if (!isInsideDirectory(fs.realpathSync(link), fs.realpathSync(dataDir))) return null;
  } catch {
    return null;
  }
  return {
    update: [{ command: link, args: ['update'] }],
    reinstall: [{ command: link, args: ['install', 'latest', '--force'] }],
    uninstall: [{ remove: [link, dataDir] }],
  };
};

/** Installs, updates and removes Claude Code from npm or its native installer and streams the output. */
export class ClaudeInstaller extends CliInstaller {
  constructor(options = {}) {
    super({
      packageName: OFFICIAL_PACKAGE_NAME,
      detect: detectClaudeInstallation,
      nativePlan: claudeNativePlan,
      doctorArgs: ['doctor'],
      configPaths: (home) => [path.join(home, '.claude'), path.join(home, '.claude.json')],
    }, options);
  }
}

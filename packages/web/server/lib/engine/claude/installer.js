import { CliInstaller, detectCliInstallation } from '../cli-installer.js';
import { resolveClaudeExecutable } from './platform.js';

export { resolvePackageManager } from '../cli-installer.js';

export const OFFICIAL_PACKAGE_NAME = '@anthropic-ai/claude-code';

/** Whether Claude Code is installed, with its version and command path. */
export const detectClaudeInstallation = (options = {}) => detectCliInstallation({
  packageName: OFFICIAL_PACKAGE_NAME,
  productName: 'Claude Code',
  resolveExecutable: resolveClaudeExecutable,
}, options);

/** Installs Claude Code from its official npm package and streams the output. */
export class ClaudeInstaller extends CliInstaller {
  constructor(options = {}) {
    super({ packageName: OFFICIAL_PACKAGE_NAME, detect: detectClaudeInstallation }, options);
  }
}

import path from 'node:path';
import { CliInstaller, detectCliInstallation } from '../cli-installer.js';
import { resolveCodexExecutableAsync } from './platform.js';

export const OFFICIAL_PACKAGE_NAME = '@openai/codex';

/** Whether the Codex CLI is installed, with its version and command path. */
export const detectCodexInstallation = (options = {}) => detectCliInstallation({
  packageName: OFFICIAL_PACKAGE_NAME,
  productName: 'Codex',
  resolveExecutable: resolveCodexExecutableAsync,
}, options);

/** Installs, updates and removes the Codex CLI from its official npm package and streams the output. */
export class CodexInstaller extends CliInstaller {
  constructor(options = {}) {
    super({
      packageName: OFFICIAL_PACKAGE_NAME,
      detect: detectCodexInstallation,
      doctorArgs: ['doctor'],
      configPaths: (home) => [path.join(home, '.codex')],
    }, options);
  }
}

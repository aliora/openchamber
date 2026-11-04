import { EventEmitter } from 'node:events';
import { runCli } from '../cli-platform.js';
import { resolveOpenCodeExecutable } from './platform.js';

export const inspectOpenCodeExecutable = async ({ env, resolveExecutable = () => resolveOpenCodeExecutable({ env }), run = runCli } = {}) => {
  const resolved = await resolveExecutable();
  const result = await run(resolved, ['--version'], { timeoutMs: 5000 });
  const version = result.stdout.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
  if (result.code !== 0 || !version) throw new Error('Could not read the OpenCode CLI version.');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 2 || (minor === 0 && patch < 29)) throw new Error('This engine requires OpenCode 2.0.29 or newer within 2.x.');
  return { ...resolved, version };
};

/** Discovery is asynchronous; the existing installer route offers the terminal command. */
export class OpenCodeInstaller extends EventEmitter {
  constructor({ getEnvironment = () => process.env } = {}) {
    super();
    this.status = { installed: false, version: null, command: null, state: 'idle', canInstall: false, installCommand: 'npm install -g @opencode/cli' };
    this.checkedAt = 0;
    this.getEnvironment = getEnvironment;
  }
  getStatus(force = false) {
    if (force || Date.now() - this.checkedAt > 5000) void this.refresh();
    return this.status;
  }
  refresh() {
    if (!this.pending) this.pending = Promise.resolve(this.getEnvironment()).then((env) => inspectOpenCodeExecutable({ env })).then((resolved) => {
      this.status = { ...this.status, installed: true, version: resolved.version, command: resolved.command, error: null };
    }).catch((error) => {
      this.status = { ...this.status, installed: false, command: null, version: null, error: error.message };
    }).finally(() => { this.checkedAt = Date.now(); this.pending = null; });
    return this.pending;
  }
  getLogs() { return []; }
  async install() { throw new Error('Install OpenCode in a terminal: npm install -g @opencode/cli'); }
}

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { cliNeedsShell } from '../cli-platform.js';
import { toolServerEnvironment } from '../tool-server.js';
import { inspectOpenCodeExecutable } from './installer.js';
import { applyProviderEnvAliases } from '../../opencode/provider-env-aliases.js';
import { stopOpenCodeChild } from './platform.js';

const services = new Set();
const execute = promisify(execFile);
export const stopOpenCodeServices = async () => { await Promise.all([...services].map((service) => service.stop())); };

/** A private upstream service; credentials/config never reach the UI. */
export class OpenCodeService extends EventEmitter {
  constructor({ cwd, toolServer, getEnvironment = () => process.env, resolveExecutable = (env) => inspectOpenCodeExecutable({ env }), spawnProcess = spawn, stopChild = stopOpenCodeChild, startupMs = 15000 } = {}) {
    super();
    Object.assign(this, { cwd, toolServer, getEnvironment, resolveExecutable, spawnProcess, stopChild, startupMs });
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.directory = null;
    this.baseUrl = null;
  }

  start() {
    services.add(this);
    if (!this.starting) this.starting = this.launch().catch(async (error) => { await this.stop(); throw error; });
    return this.starting;
  }

  async launch() {
    const baseEnv = applyProviderEnvAliases(await this.getEnvironment());
    const resolved = await this.resolveExecutable(baseEnv);
    if (this.cancelled) throw new Error('OpenCode service stopped during startup.');
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-opencode-'));
    if (this.cancelled) { await this.removeTemporaryFiles(); throw new Error('OpenCode service stopped during startup.'); }
    const source = baseEnv.OPENCODE_CONFIG;
    // Keep relative plugin/config references relative to the original file.
    const configPath = source ? path.join(path.dirname(path.resolve(source)), `.openchamber-${randomUUID()}.json`) : path.join(this.directory, 'managed.json');
    let config = {};
    if (source) {
      const errors = [];
      config = parse(await readFile(source, 'utf8'), errors);
      if (errors.length || !config || Array.isArray(config) || typeof config !== 'object') throw new Error('The configured OpenCode config is not a valid object.');
    }
    if (this.toolServer) config.mcp = { ...config.mcp, servers: { ...config.mcp?.servers, [this.toolServer.name]: {
      type: 'remote', url: this.toolServer.url, headers: { Authorization: `Bearer ${this.toolServer.token}` },
    } } };
    this.configPath = configPath;
    if (this.cancelled) throw new Error('OpenCode service stopped during startup.');
    this.writing = (async () => {
      await writeFile(configPath, '', { mode: 0o600, flag: 'wx' });
      if (process.platform === 'win32') {
        try {
          const system32 = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
          const identity = await execute(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 });
          const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
          if (!sid) throw new Error('Missing Windows identity');
          await execute(path.join(system32, 'icacls.exe'), [configPath, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true, timeout: 5000 });
        } catch { throw new Error('Could not protect the private OpenCode config file.'); }
      }
      await writeFile(configPath, JSON.stringify(config));
    })();
    await this.writing;
    if (this.cancelled) { await this.removeTemporaryFiles(); throw new Error('OpenCode service stopped during startup.'); }
    const password = randomUUID();
    let env = this.toolServer ? toolServerEnvironment(this.toolServer.url, baseEnv) : { ...baseEnv };
    env = { ...env, OPENCODE_CONFIG: configPath, OPENCODE_SERVER_PASSWORD: password };
    const child = this.spawnProcess(resolved.command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: this.cwd, env, shell: cliNeedsShell(resolved), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.baseUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const finish = (error, url) => {
        clearTimeout(timer);
        child.stdout.off('data', receive); child.stderr.off('data', receive);
        child.off('error', failed); child.off('exit', exited);
        if (error) reject(error); else resolve(url);
      };
      const receive = (data) => {
        buffer = (buffer + data.toString()).slice(-16000);
        const url = buffer.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) finish(null, url);
      };
      const failed = () => finish(new Error('OpenCode service could not start. Check the configured CLI binary.'));
      const exited = (code) => finish(new Error(`OpenCode service exited during startup (${code}).`));
      const timer = setTimeout(() => finish(new Error('OpenCode service startup timed out.')), this.startupMs);
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', failed); child.once('exit', exited);
    });
    // Drain logs without retaining sensitive prompt/provider output.
    child.stdout.resume(); child.stderr.resume();
    child.once('exit', () => { if (!this.stopping) this.emit('exit'); });
    this.client = OpenCode.make({ baseUrl: this.baseUrl, headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'x-opencode-directory': encodeURIComponent(this.cwd),
    } });
    return this.client;
  }

  stop() {
    this.cancelled = true;
    if (!this.stopping) this.stopping = (async () => {
      await this.writing?.catch(() => {});
      await this.stopChild(this.child);
      await this.removeTemporaryFiles();
      services.delete(this);
    })();
    return this.stopping;
  }

  async removeTemporaryFiles() {
    if (this.configPath) await rm(this.configPath, { force: true });
    if (!this.directory) return;
    const target = path.resolve(this.directory);
    const prefix = path.resolve(os.tmpdir(), 'openchamber-opencode-');
    if (!target.startsWith(prefix) || path.dirname(target) !== path.resolve(os.tmpdir())) throw new Error('Invalid OpenCode temporary directory.');
    await rm(target, { recursive: true, force: true });
  }
}

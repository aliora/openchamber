import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliNeedsShell, runCli, shellCommand } from './cli-platform.js';

// Detecting, installing, updating and removing a coding CLI, shared by every
// engine. An engine passes its package name, executable resolver and, for a
// CLI with its own installer, the native steps.

/**
 * Detects whether the CLI is installed. Reads the version from the package's
 * own package.json when the binary sits in an npm prefix, and otherwise asks
 * the binary for `--version`.
 */
export const detectCliInstallation = async (spec, options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;
  const isWindows = targetPlatform === 'win32';
  const packagePath = spec.packageName.split('/');

  try {
    const resolved = await spec.resolveExecutable({ platform: targetPlatform, env });
    const { command } = resolved;

    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      return {
        installed: false,
        version: null,
        command: null,
        isWindows,
        error: `Executable path not found: ${command}`,
      };
    }

    if (path.isAbsolute(command)) {
      const candidates = [
        path.join(path.dirname(command), '..', 'package.json'),
        path.join(path.dirname(command), 'node_modules', ...packagePath, 'package.json'),
        path.join(path.dirname(command), '..', 'lib', 'node_modules', ...packagePath, 'package.json'),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(cand, 'utf8'));
            if (pkg.name === spec.packageName && pkg.version) {
              return {
                installed: true,
                version: pkg.version,
                rawVersion: `${pkg.version} (${spec.productName})`,
                command,
                isWindows,
                managedByNpm: true,
              };
            }
          } catch {
            // An unreadable package.json falls through to the CLI probe.
          }
        }
      }
    }

    const res = await runCli({ command, isWindows }, ['--version'], { timeoutMs: 10000, env });

    if (res.error) {
      return {
        installed: false,
        version: null,
        command: null,
        isWindows,
        error: res.error,
      };
    }

    const output = res.stdout.trim();
    if (res.code === 0 && output) {
      // "2.1.301 (Claude Code)", "codex-cli 0.163.0" or a bare version.
      const versionMatch = output.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/);
      const parsedVersion = versionMatch ? versionMatch[1] : output.split(/\s+/)[0];

      return {
        installed: true,
        version: parsedVersion,
        rawVersion: output,
        command,
        isWindows,
      };
    }

    return {
      installed: false,
      version: null,
      command: null,
      isWindows,
      exitCode: res.code,
      stderr: res.stderr.trim(),
    };
  } catch (err) {
    return {
      installed: false,
      version: null,
      command: null,
      isWindows,
      error: err.message,
    };
  }
};

/**
 * Resolves the package manager that runs the official installation.
 * On Windows, explicitly resolves `npm.cmd` to bypass PowerShell ExecutionPolicy issues with `npm.ps1`.
 */
export const resolvePackageManager = (options = {}) => {
  const fileExists = options.fileExists || fs.existsSync;
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;
  const isWindows = targetPlatform === 'win32';

  if (isWindows) {
    const commonNodeLocations = [
      env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs', 'npm.cmd') : null,
      env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs', 'npm.cmd') : null,
      env.APPDATA ? path.join(env.APPDATA, 'npm', 'npm.cmd') : null,
    ].filter(Boolean);

    for (const loc of commonNodeLocations) {
      if (fileExists(loc)) {
        return { manager: 'npm', command: loc, isWindows: true };
      }
    }

    try {
      const where = spawnSync('where.exe', ['npm.cmd'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (where.stdout) {
        const found = where.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s.endsWith('.cmd'));
        if (found) {
          return { manager: 'npm', command: found, isWindows: true };
        }
      }
    } catch {
      // where.exe is missing or timed out: fall back to the wrapper name.
    }

    return { manager: 'npm', command: 'npm.cmd', isWindows: true };
  }

  const unixNpmLocations = ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'];
  if (env.HOME) {
    unixNpmLocations.push(path.join(env.HOME, '.npm-global', 'bin', 'npm'));
  }

  for (const loc of unixNpmLocations) {
    if (fileExists(loc)) {
      return { manager: 'npm', command: loc, isWindows: false };
    }
  }

  return { manager: 'npm', command: 'npm', isWindows: false };
};

const LATEST_VERSION_TTL_MS = 60 * 60 * 1000;
const NPM_VIEW_TIMEOUT_MS = 10000;

const parseVersionParts = (version) => String(version).split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);

export const isNewerVersion = (latest, current) => {
  if (!latest || !current) return false;
  const a = parseVersionParts(latest);
  const b = parseVersionParts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

export const fetchLatestNpmVersion = (packageName, options = {}) => new Promise((resolve, reject) => {
  const pm = resolvePackageManager(options);
  const child = spawn(shellCommand(pm.command, pm.isWindows), ['view', packageName, 'version'], {
    shell: pm.isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`npm view ${packageName} timed out`));
  }, NPM_VIEW_TIMEOUT_MS);
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const version = output.trim();
    if (code === 0 && version) resolve(version);
    else reject(new Error(`npm view ${packageName} exited with code ${code}`));
  });
});

export const createLatestVersionLookup = ({
  packageName,
  fetchLatest = () => fetchLatestNpmVersion(packageName),
  now = Date.now,
  ttlMs = LATEST_VERSION_TTL_MS,
}) => {
  let latest = null;
  let readAt = null;
  let reading = false;

  const refresh = () => {
    reading = true;
    readAt = now();
    fetchLatest()
      .then((version) => { latest = version; })
      .catch((error) => { console.warn(`[engine] latest version of ${packageName} unavailable: ${error.message}`); })
      .finally(() => { reading = false; });
  };

  return {
    peek() {
      const stale = readAt === null || now() - readAt >= ttlMs;
      if (stale && !reading) refresh();
      return latest;
    },
  };
};

export const ENGINE_ACTIONS = ['install', 'update', 'uninstall', 'reinstall', 'doctor'];

export const isInsideDirectory = (child, parent) => {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const realpathOrNull = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

const quoteArg = (arg) => (/^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

const describeStep = (step) => {
  if (step.display) return step.display;
  if (step.remove) return `rm -rf ${step.remove.map(quoteArg).join(' ')}`;
  return [step.command, ...step.args].map(quoteArg).join(' ');
};

const describeSteps = (steps) => (steps ? steps.map(describeStep).join(' && ') : null);

export const scriptStep = (script, platform) => (platform === 'win32'
  ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', script], display: script }
  : { command: '/bin/bash', args: ['-c', script], display: script });

const isBrewPath = (target) => /\/(Cellar|Caskroom)\//.test(target || '');

const removePathRecursively = (target) => fs.rmSync(target, { recursive: true, force: true });

const FOUND_DETECTION_TTL_MS = 15000;
const MISSING_DETECTION_TTL_MS = 5000;

/**
 * Installs, updates, removes and checks one CLI and streams the output as
 * `log` events; `status` events report `installing` (any running action),
 * `completed` or `failed` with the action's name. A spec with `packageName`
 * manages the npm package; `nativePlan` describes the CLI's own installer.
 */
export class CliInstaller extends EventEmitter {
  constructor(spec, options = {}) {
    super();
    this.spec = spec;
    this.packageName = spec.packageName ?? null;
    this.detect = spec.detect;
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.home = options.home || this.env.HOME || os.homedir();
    this.spawnProcess = options.spawnProcess || spawn;
    this.removePath = options.removePath || removePathRecursively;
    this.fileExists = options.fileExists || fs.existsSync;
    this.state = 'idle';
    this.action = null;
    this.logs = [];
    this.lastError = null;
    this.lastResult = null;
    this.latestVersion = this.packageName
      ? createLatestVersionLookup({ packageName: this.packageName, fetchLatest: options.fetchLatest })
      : null;
  }

  _detect(forceRefresh) {
    if (!forceRefresh && this._cachedDetection && Date.now() < this._cachedDetectionExpiresAt) {
      return Promise.resolve(this._cachedDetection);
    }
    if (!forceRefresh && this._pendingDetection) return this._pendingDetection;

    const lookup = new Promise((resolve) => resolve(this.detect({ platform: this.platform, env: this.env })))
      .then((detection) => {
        if (this._pendingDetection === lookup) {
          this._cachedDetection = detection;
          this._cachedDetectionExpiresAt = Date.now() + (detection.installed ? FOUND_DETECTION_TTL_MS : MISSING_DETECTION_TTL_MS);
        }
        return detection;
      })
      .finally(() => {
        if (this._pendingDetection === lookup) this._pendingDetection = null;
      });
    this._pendingDetection = lookup;
    return lookup;
  }

  _packageManager() {
    return resolvePackageManager({ platform: this.platform, env: this.env, fileExists: this.fileExists });
  }

  _npmStep(args) {
    const pm = this._packageManager();
    return { command: pm.command, args, shell: pm.isWindows, display: ['npm', ...args].join(' ') };
  }

  _freshInstallSteps() {
    if (this.spec.installScript) return [scriptStep(this.spec.installScript, this.platform)];
    return [this._npmStep(['install', '-g', `${this.packageName}@latest`])];
  }

  _configPaths() {
    return (this.spec.configPaths?.(this.home) ?? []).filter((target) => this.fileExists(target));
  }

  _withConfigRemoval(steps, removeConfig) {
    const configPaths = removeConfig ? this._configPaths() : [];
    return configPaths.length > 0 ? [...steps, { remove: configPaths }] : steps;
  }

  /**
   * The steps each action runs for the detected installation, or `null` for
   * an action the server cannot run, with where the CLI came from.
   */
  planActions(detection, { removeConfig = false } = {}) {
    const steps = { install: null, update: null, uninstall: null, reinstall: null, doctor: null };
    if (!detection.installed) {
      return { installSource: 'unknown', steps: { ...steps, install: this._freshInstallSteps() } };
    }
    if (this.spec.doctorArgs) steps.doctor = [{ command: detection.command, args: this.spec.doctorArgs, shell: cliNeedsShell(detection) }];

    if (detection.managedByNpm) {
      const latest = [this._npmStep(['install', '-g', `${this.packageName}@latest`])];
      return {
        installSource: 'npm',
        steps: {
          ...steps,
          install: latest,
          update: latest,
          reinstall: [this._npmStep(['install', '-g', `${this.packageName}@latest`, '--force'])],
          uninstall: this._withConfigRemoval([this._npmStep(['uninstall', '-g', this.packageName])], removeConfig),
        },
      };
    }

    const native = this.spec.nativePlan?.({ detection, home: this.home, platform: this.platform, installScript: this.spec.installScript });
    if (native) {
      return {
        installSource: 'native',
        steps: {
          ...steps,
          install: native.update,
          update: native.update,
          reinstall: native.reinstall,
          uninstall: this._withConfigRemoval(native.uninstall, removeConfig),
        },
      };
    }

    return { installSource: isBrewPath(realpathOrNull(detection.command)) ? 'brew' : 'unknown', steps };
  }

  async getStatus(forceRefresh = false) {
    const detection = await this._detect(forceRefresh);
    const { installSource, steps } = this.planActions(detection);
    const pm = this.packageName ? this._packageManager() : null;
    const latestVersion = this.latestVersion?.peek() ?? null;
    const commands = Object.fromEntries(ENGINE_ACTIONS.map((action) => [action, describeSteps(steps[action])]));
    const tracksLatest = installSource === 'npm' || installSource === 'native';

    return {
      state: this.state,
      action: this.action,
      installed: detection.installed,
      version: detection.version,
      rawVersion: detection.rawVersion,
      command: detection.command,
      installSource,
      actions: Object.fromEntries(ENGINE_ACTIONS.map((action) => [action, Boolean(steps[action])])),
      commands,
      packageManager: pm && (!detection.installed || detection.managedByNpm) ? pm.manager : null,
      packageManagerCommand: pm?.command ?? null,
      canInstall: Boolean(steps.install),
      installCommand: commands.install ?? describeSteps(this._freshInstallSteps()),
      latestVersion,
      updateAvailable: detection.installed && tracksLatest && isNewerVersion(latestVersion, detection.version),
      logsCount: this.logs.length,
      lastError: this.lastError || detection.error || detection.stderr || null,
      detection,
    };
  }

  getLogs() {
    return [...this.logs];
  }

  _appendLog(stream, text) {
    const entry = {
      stream,
      text,
      timestamp: Date.now(),
    };
    this.logs.push(entry);
    this.emit('log', entry);
  }

  install(options = {}) {
    if (this.state === 'installing') return this._runPromise;
    return this.runAction('install', options);
  }

  /**
   * Runs one action. Rejects with `code: 'busy'` while another one runs,
   * including one that started while this one detected the installation, and
   * with `code: 'unsupported'` for an action the installation does not offer.
   */
  async runAction(action, options = {}) {
    const busy = () => Object.assign(new Error(`${this.action} is already running`), { code: 'busy' });
    if (this.state === 'installing') throw busy();
    const plan = this.planActions(await this._detect(true), { removeConfig: options.removeConfig === true });
    if (this.state === 'installing') throw busy();
    const steps = plan.steps[action];
    if (!steps) {
      throw Object.assign(new Error(`${action} is not available for this installation`), { code: 'unsupported' });
    }

    this.state = 'installing';
    this.action = action;
    this.logs = [];
    this.lastError = null;
    this.lastResult = null;
    this.emit('status', { state: 'installing', action });

    this._runPromise = this._runSteps(action, steps);
    return this._runPromise;
  }

  async _runSteps(action, steps) {
    try {
      steps.forEach((step) => step.remove?.forEach((target) => this._assertRemovable(target)));
      for (const step of steps) {
        await this._runStep(step);
      }
      this._appendLog('system', `${action} completed successfully.\n`);
      this._cachedDetection = null;
      const verify = await this._detect(true);
      this.state = 'completed';
      this.lastResult = verify;
      this.emit('status', { state: 'completed', action, result: verify });
      this.emit('completed', verify);
      return verify;
    } catch (err) {
      this._cachedDetection = null;
      this.state = 'failed';
      this.lastError = err.message;
      this._appendLog('system', `${err.message}\n`);
      this.emit('status', { state: 'failed', action, error: err.message });
      throw err;
    }
  }

  _assertRemovable(target) {
    if (!path.isAbsolute(target) || !isInsideDirectory(target, this.home)) {
      throw new Error(`Refusing to remove ${target}: it is outside ${this.home}`);
    }
  }

  _runStep(step) {
    this._appendLog('system', `$ ${describeStep(step)}\n`);
    if (step.remove) {
      step.remove.forEach((target) => this.removePath(target));
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(shellCommand(step.command, Boolean(step.shell)), step.args, {
        shell: Boolean(step.shell),
        windowsHide: true,
        env: { ...process.env, ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => this._appendLog('stdout', chunk.toString()));
      child.stderr.on('data', (chunk) => this._appendLog('stderr', chunk.toString()));
      child.on('error', (err) => reject(new Error(`Could not start ${step.command}: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(Object.assign(new Error(`${describeStep(step)} exited with code ${code}`), { code }));
      });
    });
  }
}

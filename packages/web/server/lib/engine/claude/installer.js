import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { resolveClaudeExecutable } from './platform.js';

export const OFFICIAL_PACKAGE_NAME = '@anthropic-ai/claude-code';

/**
 * Detects whether Claude Code CLI is installed on the host system.
 * Returns installation details including version and command path.
 */
export const detectClaudeInstallation = (options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;
  const isWindows = targetPlatform === 'win32';

  try {
    const { command } = resolveClaudeExecutable({ platform: targetPlatform, env });

    // Verify command exists if absolute path is provided
    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      return {
        installed: false,
        version: null,
        command: null,
        isWindows,
        error: `Executable path not found: ${command}`,
      };
    }

    // Fast-path: read package.json version directly without spawning process if available
    if (path.isAbsolute(command)) {
      const candidates = [
        path.join(path.dirname(command), '..', 'package.json'),
        path.join(path.dirname(command), 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
        path.join(path.dirname(command), '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(cand, 'utf8'));
            if (pkg.name === OFFICIAL_PACKAGE_NAME && pkg.version) {
              return {
                installed: true,
                version: pkg.version,
                rawVersion: `${pkg.version} (Claude Code)`,
                command,
                isWindows,
              };
            }
          } catch {
            // Ignore JSON read errors and fall through to CLI probe
          }
        }
      }
    }

    const isCmdOrBat = isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));

    // Probe version
    const res = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      shell: isCmdOrBat,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (res.error) {
      return {
        installed: false,
        version: null,
        command: null,
        isWindows,
        error: res.error.message,
      };
    }

    const output = (res.stdout || '').trim();
    if (res.status === 0 && output) {
      // Typically returns "2.1.301 (Claude Code)" or "2.1.301"
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
      exitCode: res.status,
      stderr: (res.stderr || '').trim(),
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
 * Resolves the appropriate package manager to run the official installation.
 * On Windows, explicitly resolves `npm.cmd` to bypass PowerShell ExecutionPolicy issues with `npm.ps1`.
 */
export const resolvePackageManager = (options = {}) => {
  const targetPlatform = options.platform || process.platform;
  const env = options.env || process.env;
  const isWindows = targetPlatform === 'win32';

  if (isWindows) {
    // 1. Check Node.js default location for npm.cmd
    const commonNodeLocations = [
      env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs', 'npm.cmd') : null,
      env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs', 'npm.cmd') : null,
      env.APPDATA ? path.join(env.APPDATA, 'npm', 'npm.cmd') : null,
    ].filter(Boolean);

    for (const loc of commonNodeLocations) {
      if (fs.existsSync(loc)) {
        return { manager: 'npm', command: loc, isWindows: true };
      }
    }

    // 2. Try where.exe npm.cmd
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
      // Ignore
    }

    // 3. Fallback to npm.cmd name
    return { manager: 'npm', command: 'npm.cmd', isWindows: true };
  }

  // Unix platforms (macOS / Linux)
  const unixNpmLocations = ['/usr/local/bin/npm', '/usr/bin/npm'];
  if (env.HOME) {
    unixNpmLocations.push(path.join(env.HOME, '.nvm', 'versions', 'node'));
    unixNpmLocations.push(path.join(env.HOME, '.npm-global', 'bin', 'npm'));
  }

  for (const loc of unixNpmLocations) {
    if (fs.existsSync(loc)) {
      return { manager: 'npm', command: loc, isWindows: false };
    }
  }

  return { manager: 'npm', command: 'npm', isWindows: false };
};

/**
 * Manages the installation lifecycle of Claude Code and provides live event streaming.
 */
export class ClaudeInstaller extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.state = 'idle'; // 'idle' | 'installing' | 'completed' | 'failed'
    this.logs = [];
    this.activeChild = null;
    this.lastError = null;
    this.lastResult = null;
  }

  getStatus(forceRefresh = false) {
    const now = Date.now();
    const isCached = Boolean(this._cachedDetection && now - (this._cachedDetectionTime || 0) < 15000);
    if (!isCached || forceRefresh || !this._cachedDetection?.installed) {
      this._cachedDetection = detectClaudeInstallation({
        platform: this.platform,
        env: this.env,
      });
      this._cachedDetectionTime = now;
    }
    const detection = this._cachedDetection;

    const pm = resolvePackageManager({
      platform: this.platform,
      env: this.env,
    });

    return {
      state: this.state,
      installed: detection.installed,
      version: detection.version,
      rawVersion: detection.rawVersion,
      command: detection.command,
      packageManager: pm.manager,
      packageManagerCommand: pm.command,
      canInstall: Boolean(pm.command),
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

  async install(options = {}) {
    if (this.state === 'installing') {
      return this._installPromise;
    }

    this.state = 'installing';
    this.logs = [];
    this.lastError = null;
    this.lastResult = null;
    this.emit('status', { state: 'installing' });

    const pm = resolvePackageManager({
      platform: this.platform,
      env: this.env,
    });

    const pkg = options.package || OFFICIAL_PACKAGE_NAME;
    const args = ['install', '-g', pkg];

    this._appendLog('system', `Starting official installation: ${pm.command} ${args.join(' ')}\n`);

    this._installPromise = new Promise((resolve, reject) => {
      try {
        const child = spawn(pm.command, args, {
          shell: pm.isWindows,
          windowsHide: true,
          env: { ...process.env, ...this.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.activeChild = child;

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          this._appendLog('stdout', text);
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          this._appendLog('stderr', text);
        });

        child.on('error', (err) => {
          this.state = 'failed';
          this.lastError = err.message;
          this.activeChild = null;
          this._appendLog('system', `Error spawning installer: ${err.message}\n`);
          this.emit('status', { state: 'failed', error: err.message });
          this.emit('error', err);
          reject(err);
        });

        child.on('close', (code) => {
          this.activeChild = null;
          if (code === 0) {
            this._appendLog('system', `Installation completed successfully (exit code 0).\n`);

            // Verify installation
            this._cachedDetection = null;
            const verify = detectClaudeInstallation({
              platform: this.platform,
              env: this.env,
            });

            this.state = 'completed';
            this.lastResult = verify;
            this.emit('status', { state: 'completed', result: verify });
            this.emit('completed', verify);
            resolve(verify);
          } else {
            const errMsg = `Installation process exited with code ${code}`;
            this.state = 'failed';
            this.lastError = errMsg;
            this._appendLog('system', `${errMsg}\n`);
            this.emit('status', { state: 'failed', error: errMsg });
            const error = new Error(errMsg);
            error.code = code;
            this.emit('error', error);
            reject(error);
          }
        });
      } catch (err) {
        this.state = 'failed';
        this.lastError = err.message;
        this.activeChild = null;
        this._appendLog('system', `Execution error: ${err.message}\n`);
        this.emit('status', { state: 'failed', error: err.message });
        reject(err);
      }
    });

    return this._installPromise;
  }
}

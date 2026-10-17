import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkingDirectoryChange } from './workingDirectoryChange';
import { buildServerEnvironment, launchOpenChamberServer } from './openchamber-server-process';
import { createServerLifecycle, type ConnectionStatus } from './openchamber-server-lifecycle';

export type { ConnectionStatus };

const t = vscode.l10n.t;

const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_SHUTDOWN_GRACE_MS = 5_000;
// Waits before restarting a server that stopped on its own. After the last
// one the status stays `error` until the user restarts the connection.
const SERVER_RESTART_DELAYS_MS = [1_000, 5_000, 15_000];
const SERVER_STABLE_AFTER_MS = 60_000;

type ServerDebugInfo = {
  mode: 'managed' | 'external';
  lastError?: string;
  serverScript: string;
  startCount: number;
  restartCount: number;
  lastExit: string | null;
};

type SetWorkingDirectoryResult =
  | { success: true; path: string }
  | { success: false; error: string };

/**
 * The server behind the webview's OpenCode 2.x API calls: the OpenChamber
 * server bundled with the extension, whose engine routes answer them, or the
 * already running one `openchamber.apiUrl` names.
 */
export interface OpenCodeManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  setWorkingDirectory(path: string): Promise<SetWorkingDirectoryResult>;
  getStatus(): ConnectionStatus;
  getApiUrl(): string | null;
  /**
   * Always empty. The bundled server listens on loopback without a UI
   * password, as the desktop app's does: the server calls its own routes
   * without credentials, and those calls fail once a password is set.
   */
  getOpenCodeAuthHeaders(): Record<string, string>;
  /** The managed server's launch environment; null while none runs (external URL, stopped). */
  getManagedLaunchEnvironment(): NodeJS.ProcessEnv | null;
  getWorkingDirectory(): string;
  getDebugInfo(): ServerDebugInfo;
  onStatusChange(callback: (status: ConnectionStatus, error?: string) => void): vscode.Disposable;
}

export function createOpenCodeManager(context: vscode.ExtensionContext): OpenCodeManager {
  const listeners = new Set<(status: ConnectionStatus, error?: string) => void>();
  let workingDirectory = normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir());

  const configuredApiUrl = (vscode.workspace.getConfiguration('openchamber').get<string>('apiUrl') || '').trim().replace(/\/+$/, '');
  const serverScript = vscode.Uri.joinPath(context.extensionUri, 'dist', 'openchamber-server', 'server.mjs').fsPath;
  // Keeps the server out of every workspace; each request names its directory.
  const serverCwd = normalizeWindowsDriveLetter(context.globalStorageUri.fsPath);
  let serverEnv: NodeJS.ProcessEnv | null = null;

  // The webview shows this text while the connection is down.
  const describeError = (error: string | undefined) => (error ? t('Failed to start the OpenChamber server: {0}', error) : undefined);
  const notify = (status: ConnectionStatus, error?: string) => {
    listeners.forEach((callback) => callback(status, describeError(error)));
  };

  const lifecycle = createServerLifecycle({
    launch: async (signal) => {
      fs.mkdirSync(serverCwd, { recursive: true });
      const env = buildServerEnvironment(process.env);
      const server = await launchOpenChamberServer({
        execPath: process.execPath,
        scriptPath: serverScript,
        cwd: serverCwd,
        env,
        timeoutMs: SERVER_READY_TIMEOUT_MS,
        shutdownGraceMs: SERVER_SHUTDOWN_GRACE_MS,
        signal,
      });
      serverEnv = env;
      return server;
    },
    restartDelaysMs: SERVER_RESTART_DELAYS_MS,
    stableAfterMs: SERVER_STABLE_AFTER_MS,
    onStatusChange: notify,
    log: (line) => console.warn(`[OpenChamber] ${line}`),
  });

  // A server `openchamber.apiUrl` names is not ours to start or stop.
  let externalStatus: ConnectionStatus = 'disconnected';
  const setExternalStatus = (status: ConnectionStatus) => {
    if (externalStatus === status) return;
    externalStatus = status;
    notify(status);
  };

  const getStatus = (): ConnectionStatus => (configuredApiUrl ? externalStatus : lifecycle.getStatus());

  return {
    start: async () => {
      if (configuredApiUrl) return setExternalStatus('connected');
      await lifecycle.start();
    },
    stop: async () => {
      if (configuredApiUrl) return setExternalStatus('disconnected');
      await lifecycle.stop();
    },
    restart: async () => {
      if (configuredApiUrl) return setExternalStatus('connected');
      await lifecycle.restart();
    },
    setWorkingDirectory: async (newPath) => {
      const trimmed = newPath.trim();
      const stat = trimmed ? await fs.promises.stat(trimmed).catch(() => null) : null;
      if (!stat?.isDirectory()) return { success: false, error: 'path not found' };
      workingDirectory = resolveWorkingDirectoryChange(workingDirectory, trimmed).path;
      return { success: true, path: workingDirectory };
    },
    getStatus,
    getApiUrl: () => configuredApiUrl || lifecycle.getUrl(),
    getOpenCodeAuthHeaders: () => ({}),
    getManagedLaunchEnvironment: () => (lifecycle.getUrl() ? serverEnv : null),
    getWorkingDirectory: () => workingDirectory,
    getDebugInfo: () => {
      const snapshot = lifecycle.snapshot();
      return {
        mode: configuredApiUrl ? 'external' : 'managed',
        lastError: snapshot.lastError,
        serverScript: path.relative(context.extensionUri.fsPath, serverScript),
        startCount: snapshot.startCount,
        restartCount: snapshot.restartCount,
        lastExit: snapshot.lastExit,
      };
    },
    onStatusChange(callback) {
      listeners.add(callback);
      const snapshot = lifecycle.snapshot();
      if (configuredApiUrl) callback(externalStatus);
      else callback(snapshot.status, describeError(snapshot.lastError));
      return new vscode.Disposable(() => listeners.delete(callback));
    },
  };
}

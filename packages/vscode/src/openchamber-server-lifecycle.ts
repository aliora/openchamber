import { describeExit, type ServerProcess } from './openchamber-server-process';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type ServerLifecycleOptions = {
  /** Starts one server and resolves once it is ready; rejects when it cannot start. */
  launch: (signal: AbortSignal) => Promise<ServerProcess>;
  /**
   * Waits before each restart after the server exits on its own. One entry per
   * attempt; when they run out the status stays `error` until the next start.
   */
  restartDelaysMs: readonly number[];
  /** A server that ran this long before exiting starts the restart count again. */
  stableAfterMs: number;
  onStatusChange: (status: ConnectionStatus, error: string | undefined) => void;
  log: (line: string) => void;
};

type ServerLifecycleSnapshot = {
  status: ConnectionStatus;
  lastError: string | undefined;
  startCount: number;
  restartCount: number;
  /** How the last server that stopped on its own exited. */
  lastExit: string | null;
};

/**
 * One managed OpenChamber server: start, stop, restart, and restart after an
 * unexpected exit. Operations run in order; `stop` cancels a startup in
 * progress and invalidates starts and restarts queued before it.
 */
export function createServerLifecycle(options: ServerLifecycleOptions) {
  let current: ServerProcess | null = null;
  let connectedAt = 0;
  let startup: AbortController | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0;
  let queue: Promise<void> = Promise.resolve();
  let status: ConnectionStatus = 'disconnected';
  let lastError: string | undefined;
  let failuresInRow = 0;
  let startCount = 0;
  let restartCount = 0;
  let lastExit: string | null = null;

  const setStatus = (next: ConnectionStatus, error?: string) => {
    if (status === next && lastError === error) return;
    status = next;
    lastError = error;
    options.onStatusChange(status, lastError);
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const run = queue.then(operation);
    queue = run.catch(() => {});
    return run;
  };

  const cancelRecovery = () => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const closeCurrent = async () => {
    const server = current;
    current = null;
    await server?.close();
  };

  /** Starts a server; the error message when it cannot, null once it is connected. */
  const launchOnce = async (): Promise<string | null> => {
    startCount += 1;
    setStatus('connecting');
    const controller = new AbortController();
    startup = controller;
    try {
      const server = await options.launch(controller.signal);
      if (controller.signal.aborted) {
        await server.close();
        return null;
      }
      current = server;
      connectedAt = Date.now();
      setStatus('connected');
      void server.exited.then((exit) => onExit(server, describeExit(exit)));
      return null;
    } catch (error) {
      if (controller.signal.aborted) return null;
      return error instanceof Error ? error.message : String(error);
    } finally {
      if (startup === controller) startup = null;
    }
  };

  // A server that is closed on purpose is no longer `current` when it exits.
  const onExit = (server: ServerProcess, exit: string) => {
    if (current !== server) return;
    current = null;
    lastExit = exit;
    if (Date.now() - connectedAt >= options.stableAfterMs) failuresInRow = 0;
    options.log(`OpenChamber server exited unexpectedly (${exit}).`);
    scheduleRecovery(`The OpenChamber server stopped (${exit}).`);
  };

  const scheduleRecovery = (reason: string) => {
    const delayMs = options.restartDelaysMs[failuresInRow];
    if (delayMs === undefined) {
      setStatus('error', `It keeps stopping after ${failuresInRow} restarts. ${reason}`);
      return;
    }
    failuresInRow += 1;
    // Requests wait for `connected` while the server comes back.
    setStatus('connecting');
    const expectedRevision = revision;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void enqueue(async () => {
        if (expectedRevision !== revision || current) return;
        restartCount += 1;
        const failure = await launchOnce();
        if (failure !== null && expectedRevision === revision) scheduleRecovery(failure);
      });
    }, delayMs);
  };

  const startFresh = async () => {
    failuresInRow = 0;
    const failure = await launchOnce();
    if (failure !== null) setStatus('error', failure);
  };

  return {
    start(): Promise<void> {
      const expectedRevision = revision;
      return enqueue(async () => {
        if (expectedRevision !== revision) return;
        if (current) {
          setStatus('connected');
          return;
        }
        cancelRecovery();
        await startFresh();
      });
    },

    stop(): Promise<void> {
      revision += 1;
      startup?.abort();
      cancelRecovery();
      return enqueue(async () => {
        await closeCurrent();
        setStatus('disconnected');
      });
    },

    restart(): Promise<void> {
      const expectedRevision = revision;
      cancelRecovery();
      return enqueue(async () => {
        if (expectedRevision !== revision) return;
        restartCount += 1;
        setStatus('connecting');
        await closeCurrent();
        await startFresh();
      });
    },

    getStatus: () => status,
    /** The ready server's URL; null while there is none, including while one stops or starts. */
    getUrl: () => current?.url ?? null,
    snapshot: (): ServerLifecycleSnapshot => ({ status, lastError, startCount, restartCount, lastExit }),
  };
}

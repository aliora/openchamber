import type { Serializable } from 'node:child_process';
import { assignInjectedEnv } from './injected-env';
import { spawnOwnedIpcProcess, type ProcessExit } from './owned-process';
import { serverStartupEventSchema, type ServerCommand } from './openchamber-server-protocol';

/** A started server, listening on loopback. */
export type ServerProcess = {
  readonly url: string;
  /** Settles when the process has exited, whether it was stopped or not. */
  readonly exited: Promise<ProcessExit>;
  /** Stops the server and everything it started; safe to call more than once. */
  close(): Promise<void>;
};

export type ServerLaunchOptions = {
  /** The Node binary. In the extension host this is VS Code's own, run as Node. */
  execPath: string;
  scriptPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** How long a stopping server may shut down on its own before its process tree is killed. */
  shutdownGraceMs: number;
  signal: AbortSignal;
};

const OUTPUT_TAIL_BYTES = 32 * 1024;

/** The editor's environment, plus what tells the server where it runs. */
export const buildServerEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = assignInjectedEnv({ ...base }, {
    OPENCHAMBER_RUNTIME: 'vscode',
    // Paired devices reach this machine through the desktop app or `openchamber
    // serve`. A server inside an editor window must not host the relay.
    OPENCHAMBER_RELAY_HOST: 'off',
    // Loopback traffic gains nothing from compression.
    OPENCHAMBER_SKIP_API_COMPRESSION: 'true',
  });
  // Runs VS Code's own binary as Node. The server removes the variable from
  // its environment again, so the processes it starts do not inherit it.
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
};

export const describeExit = (exit: ProcessExit): string => {
  if (exit.error) return exit.error.message;
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
};

/**
 * Starts the bundled OpenChamber server as a child process and resolves once it
 * reports the port it listens on. Any failure before that, including timeout
 * and cancellation, terminates the child before the promise rejects.
 */
export async function launchOpenChamberServer(options: ServerLaunchOptions): Promise<ServerProcess> {
  options.signal.throwIfAborted();
  const owned = spawnOwnedIpcProcess(options.execPath, [options.scriptPath], { cwd: options.cwd, env: options.env });

  // Startup errors quote the end of what the server printed. Once it is ready
  // the streams keep draining so a chatty server never blocks on a full pipe.
  let output = '';
  let keepOutput = true;
  const capture = (chunk: Buffer) => {
    if (keepOutput) output = (output + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
  };
  owned.child.stdout?.on('data', capture);
  owned.child.stderr?.on('data', capture);

  let closing: Promise<void> | null = null;
  const close = () => {
    if (!closing) closing = (async () => {
      const stop: ServerCommand = { type: 'stop' };
      // A closed channel reports through the callback; the kill below covers it.
      if (owned.child.connected) owned.child.send(stop, () => {});
      await owned.waitForClose(options.shutdownGraceMs);
      // Sweeps what is left: a server that did not stop in time and, on POSIX,
      // the engine CLIs it started, which share its process group.
      await owned.terminate();
    })();
    return closing;
  };

  const startupError = (reason: string) => new Error(`${reason} Output: ${output.trim() || '(none)'}`);

  try {
    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const stopWaiting = () => {
        settled = true;
        clearTimeout(timer);
        owned.child.off('message', onMessage);
        options.signal.removeEventListener('abort', onAbort);
      };
      const succeed = (value: number) => {
        if (settled) return;
        stopWaiting();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        stopWaiting();
        reject(error);
      };

      const onMessage = (message: Serializable) => {
        const event = serverStartupEventSchema.safeParse(message);
        if (!event.success) return;
        if (event.data.type === 'ready') succeed(event.data.port);
        else fail(startupError(`The OpenChamber server failed to start: ${event.data.message}.`));
      };
      const onAbort = () => fail(new Error('OpenChamber server startup cancelled.'));
      const timer = setTimeout(() => fail(startupError(`The OpenChamber server did not start within ${options.timeoutMs}ms.`)), options.timeoutMs);

      owned.child.on('message', onMessage);
      options.signal.addEventListener('abort', onAbort, { once: true });
      void owned.closed.then((exit) => fail(startupError(`The OpenChamber server exited before it was ready (${describeExit(exit)}).`)));
    });
    keepOutput = false;
    output = '';
    return { url: `http://127.0.0.1:${port}`, exited: owned.closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

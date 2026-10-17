/**
 * Entry of the server child process, bundled to dist/openchamber-server/server.mjs
 * by scripts/build-server.mjs and started by openchamber-server-process.ts with
 * an IPC channel. It runs the same OpenChamber server the desktop app embeds,
 * API only and on loopback, and reports its port once it listens.
 */
import { fileURLToPath } from 'node:url';
import { startWebUiServer, type WebUiServerController } from '../../web/server/index.js';
import { serverCommandSchema, type ServerStartupEvent } from './openchamber-server-protocol';

// The extension host starts this file with its Electron binary acting as Node.
// Engine CLIs and the shells they open inherit this environment, and an
// Electron app started from there must not run as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const report = (event: ServerStartupEvent, afterSent?: () => void) => {
  process.send?.(event, undefined, undefined, () => afterSent?.());
};

if (!process.send) {
  console.error('[openchamber-server] Started without an IPC channel; the extension host starts this file.');
  process.exit(1);
}

let server: WebUiServerController | null = null;
let shuttingDown = false;

const shutDown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) void server.stop({ exitProcess: true });
  else process.exit(0);
};

// `stop` comes from the extension host; the channel closes without one when
// the extension host exits. Either way the server goes with it.
process.on('message', (message) => {
  if (serverCommandSchema.safeParse(message).success) shutDown();
});
process.once('disconnect', shutDown);

try {
  server = await startWebUiServer({
    host: '127.0.0.1',
    port: 0,
    apiOnly: true,
    attachSignals: true,
    exitOnShutdown: true,
    builtInExtensionsDir: fileURLToPath(new URL('./built-in-extensions/', import.meta.url)),
  });
  const port = server.getPort();
  if (port === null) throw new Error('The server is listening without a port.');
  report({ type: 'ready', port });
} catch (error) {
  report({ type: 'failed', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
}

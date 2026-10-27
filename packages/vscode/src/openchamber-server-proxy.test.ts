import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import type { ConnectionStatus, OpenCodeManager } from './opencode';
import { createServerLifecycle } from './openchamber-server-lifecycle';
import type { ServerProcess } from './openchamber-server-process';

type SeenRequest = { server: number; method: string; url: string; directory: string | undefined; body: string };

/**
 * Each launch starts a real HTTP server on a free loopback port, standing in
 * for the bundled OpenChamber server, and records what reaches it.
 */
const createServers = () => {
  const seen: SeenRequest[] = [];
  let launched = 0;
  const launch = async (): Promise<ServerProcess> => {
    const index = launched++;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const directory = req.headers['x-opencode-directory'];
        seen.push({ server: index, method: req.method ?? '', url: req.url ?? '', directory: Array.isArray(directory) ? directory[0] : directory, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ server: index }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = z.object({ port: z.number() }).parse(server.address());
    let settleExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => { settleExit = resolve; })
      .then(() => ({ code: 0, signal: null, error: null }));
    return {
      url: `http://127.0.0.1:${port}`,
      exited,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        settleExit();
      },
    };
  };
  return { seen, launch };
};

/** The manager surface the proxy reads, over the real lifecycle, as `opencode.ts` builds it. */
const createManager = (launch: () => Promise<ServerProcess>) => {
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const lifecycle = createServerLifecycle({
    launch,
    restartDelaysMs: [],
    stableAfterMs: 0,
    onStatusChange: (status) => listeners.forEach((listener) => listener(status)),
    log: () => {},
  });
  const manager: OpenCodeManager = {
    start: () => lifecycle.start(),
    stop: () => lifecycle.stop(),
    restart: () => lifecycle.restart(),
    setWorkingDirectory: async (path) => ({ success: true, path }),
    getStatus: () => lifecycle.getStatus(),
    getApiUrl: () => lifecycle.getUrl(),
    getOpenCodeAuthHeaders: () => ({}),
    getManagedLaunchEnvironment: () => null,
    getWorkingDirectory: () => '/workspace',
    getDebugInfo: () => ({ mode: 'managed', serverScript: 'dist/openchamber-server/server.mjs', startCount: 0, restartCount: 0, lastExit: null }),
    onStatusChange: (callback) => {
      listeners.add(callback);
      callback(lifecycle.getStatus());
      return { dispose: () => { listeners.delete(callback); } };
    },
  };
  return manager;
};

const deps = {
  tryHandleLocalFsProxy: async () => null,
  waitForWorktreeRemoval: async () => {},
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => Object.fromEntries(headers.entries()),
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const proxiedResponseSchema = z.object({ status: z.number(), bodyText: z.string() });

let requestId = 0;
const proxy = async (ctx: BridgeContext, method: string, path: string, body?: string) => {
  const response = await handleProxyBridgeMessage({
    id: `proxy-${++requestId}`,
    type: 'api:proxy',
    payload: {
      method,
      path,
      headers: { 'x-opencode-directory': '/workspace/project' },
      bodyBase64: body === undefined ? undefined : Buffer.from(body).toString('base64'),
    },
  }, ctx, deps);
  return proxiedResponseSchema.parse(response?.data);
};

describe('VS Code API proxy target', () => {
  test('forwards webview requests to the bundled server unchanged', async () => {
    const { seen, launch } = createServers();
    const manager = createManager(launch);
    await manager.start();
    try {
      const read = await proxy({ manager }, 'GET', '/api/engines?refresh=true');
      const create = await proxy({ manager }, 'POST', '/api/session', '{"title":"from the webview"}');

      assert.deepEqual(read, { status: 200, bodyText: '{"server":0}' });
      assert.equal(create.status, 200);
      assert.deepEqual(seen, [
        { server: 0, method: 'GET', url: '/api/engines?refresh=true', directory: '/workspace/project', body: '' },
        { server: 0, method: 'POST', url: '/api/session', directory: '/workspace/project', body: '{"title":"from the webview"}' },
      ]);
    } finally {
      await manager.stop();
    }
  });

  test('holds a request made during a restart and sends it to the new server', async () => {
    const { seen, launch } = createServers();
    const manager = createManager(launch);
    await manager.start();
    const firstUrl = manager.getApiUrl();
    try {
      const restarting = manager.restart();
      const pending = proxy({ manager }, 'GET', '/api/session');
      await restarting;

      assert.deepEqual(await pending, { status: 200, bodyText: '{"server":1}' });
      assert.notEqual(manager.getApiUrl(), firstUrl);
      assert.deepEqual(seen.map((request) => request.server), [1]);
    } finally {
      await manager.stop();
    }
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createServerLifecycle, type ConnectionStatus } from './openchamber-server-lifecycle';
import type { ServerProcess } from './openchamber-server-process';
import type { ProcessExit } from './owned-process';

/** A server the test controls: `crash` ends it on its own, `close` the way the lifecycle stops it. */
const createFakeServer = (port: number) => {
  let settleExit: (exit: ProcessExit) => void = () => {};
  const exited = new Promise<ProcessExit>((resolve) => { settleExit = resolve; });
  let closeCount = 0;
  const server: ServerProcess = {
    url: `http://127.0.0.1:${port}`,
    exited,
    close: async () => {
      closeCount += 1;
      settleExit({ code: 0, signal: null, error: null });
    },
  };
  return {
    server,
    crash: (exit: ProcessExit) => settleExit(exit),
    closeCount: () => closeCount,
  };
};

type FakeServer = ReturnType<typeof createFakeServer>;

/** `launch` answers from a script: a server, an error, or a startup that waits for abort. */
const createHarness = (options: { restartDelaysMs?: number[]; stableAfterMs?: number } = {}) => {
  const servers: FakeServer[] = [];
  const statuses: string[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  let hang = false;
  let launches = 0;
  let nextPort = 4000;
  const lifecycle = createServerLifecycle({
    launch: async (signal) => {
      launches += 1;
      if (hang) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      const fake = createFakeServer(nextPort++);
      servers.push(fake);
      return fake.server;
    },
    restartDelaysMs: options.restartDelaysMs ?? [10, 20],
    stableAfterMs: options.stableAfterMs ?? 60_000,
    onStatusChange: (status: ConnectionStatus, error) => { statuses.push(error ? `${status}: ${error}` : status); },
    log: (line) => { logs.push(line); },
  });
  return {
    lifecycle,
    servers,
    statuses,
    logs,
    failNextLaunches: (...messages: string[]) => { failures.push(...messages); },
    hangLaunches: (value: boolean) => { hang = value; },
    launches: () => launches,
  };
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OpenChamber server lifecycle', () => {
  test('starts once and reports the URL of the port the server listens on', async () => {
    const { lifecycle, statuses, launches } = createHarness();
    await Promise.all([lifecycle.start(), lifecycle.start()]);
    assert.equal(lifecycle.getStatus(), 'connected');
    assert.equal(lifecycle.getUrl(), 'http://127.0.0.1:4000');
    assert.equal(launches(), 1);
    assert.deepEqual(statuses, ['connecting', 'connected']);
  });

  test('reports a failed start as an error without retrying, and a later start retries', async () => {
    const { lifecycle, statuses, failNextLaunches, launches } = createHarness();
    failNextLaunches('The OpenChamber server did not start within 30000ms.');
    await lifecycle.start();
    assert.equal(lifecycle.getStatus(), 'error');
    assert.equal(lifecycle.getUrl(), null);
    assert.equal(lifecycle.snapshot().lastError, 'The OpenChamber server did not start within 30000ms.');
    await sleep(50);
    assert.equal(launches(), 1);

    await lifecycle.start();
    assert.equal(lifecycle.getStatus(), 'connected');
    assert.deepEqual(statuses, ['connecting', 'error: The OpenChamber server did not start within 30000ms.', 'connecting', 'connected']);
  });

  test('restarts a server that exits on its own, on a new port', async () => {
    const { lifecycle, servers, logs } = createHarness();
    await lifecycle.start();
    servers[0].crash({ code: null, signal: 'SIGKILL', error: null });

    await waitFor(() => lifecycle.getStatus() === 'connecting');
    assert.equal(lifecycle.getUrl(), null, 'requests wait while the server comes back');
    await waitFor(() => lifecycle.getStatus() === 'connected');

    assert.equal(lifecycle.getUrl(), 'http://127.0.0.1:4001');
    assert.equal(lifecycle.snapshot().restartCount, 1);
    assert.equal(lifecycle.snapshot().lastExit, 'signal SIGKILL');
    assert.deepEqual(logs, ['OpenChamber server exited unexpectedly (signal SIGKILL).']);
  });

  test('gives up with an error once the restarts run out', async () => {
    const { lifecycle, servers, launches } = createHarness({ restartDelaysMs: [5, 5] });
    await lifecycle.start();
    for (let index = 0; index < 3; index++) {
      await waitFor(() => servers.length === index + 1 && lifecycle.getStatus() === 'connected');
      servers[index].crash({ code: 1, signal: null, error: null });
    }
    await waitFor(() => lifecycle.getStatus() === 'error');
    assert.equal(lifecycle.snapshot().lastError, 'It keeps stopping after 2 restarts. The OpenChamber server stopped (exit code 1).');
    await sleep(30);
    assert.equal(launches(), 3);
  });

  test('counts a restart that cannot start against the same limit', async () => {
    const { lifecycle, servers, failNextLaunches, launches } = createHarness({ restartDelaysMs: [5, 5] });
    await lifecycle.start();
    failNextLaunches('exited before it was ready', 'exited before it was ready');
    servers[0].crash({ code: 1, signal: null, error: null });
    await waitFor(() => lifecycle.getStatus() === 'error');
    assert.equal(lifecycle.snapshot().lastError, 'It keeps stopping after 2 restarts. exited before it was ready');
    assert.equal(launches(), 3);
  });

  test('starts counting again after a server ran long enough', async () => {
    const { lifecycle, servers } = createHarness({ restartDelaysMs: [5], stableAfterMs: 0 });
    await lifecycle.start();
    for (let index = 0; index < 3; index++) {
      servers[index].crash({ code: 1, signal: null, error: null });
      await waitFor(() => servers.length === index + 2 && lifecycle.getStatus() === 'connected');
    }
    assert.equal(lifecycle.snapshot().restartCount, 3);
  });

  test('stop closes the server and does not treat its exit as a crash', async () => {
    const { lifecycle, servers, launches, statuses } = createHarness();
    await lifecycle.start();
    await lifecycle.stop();
    assert.equal(servers[0].closeCount(), 1);
    assert.equal(lifecycle.getStatus(), 'disconnected');
    assert.equal(lifecycle.getUrl(), null);
    await sleep(50);
    assert.equal(launches(), 1);
    assert.deepEqual(statuses, ['connecting', 'connected', 'disconnected']);
  });

  test('stop cancels a startup in progress and a start queued behind it', async () => {
    const { lifecycle, hangLaunches, launches } = createHarness();
    hangLaunches(true);
    const starting = lifecycle.start();
    const queued = lifecycle.restart();
    await waitFor(() => launches() === 1);
    await lifecycle.stop();
    await Promise.all([starting, queued]);
    assert.equal(lifecycle.getStatus(), 'disconnected');
    assert.equal(launches(), 1);
  });

  test('stop cancels a pending restart after a crash', async () => {
    const { lifecycle, servers, launches } = createHarness({ restartDelaysMs: [40] });
    await lifecycle.start();
    servers[0].crash({ code: 1, signal: null, error: null });
    await waitFor(() => lifecycle.getStatus() === 'connecting');
    await lifecycle.stop();
    await sleep(80);
    assert.equal(launches(), 1);
    assert.equal(lifecycle.getStatus(), 'disconnected');
  });

  test('a start after stop runs again', async () => {
    const { lifecycle, launches } = createHarness();
    await lifecycle.start();
    await lifecycle.stop();
    await lifecycle.start();
    assert.equal(lifecycle.getStatus(), 'connected');
    assert.equal(launches(), 2);
  });

  test('restart replaces the running server', async () => {
    const { lifecycle, servers } = createHarness();
    await lifecycle.start();
    await lifecycle.restart();
    assert.equal(servers[0].closeCount(), 1);
    assert.equal(lifecycle.getUrl(), 'http://127.0.0.1:4001');
    assert.equal(lifecycle.snapshot().restartCount, 1);
    assert.equal(lifecycle.snapshot().lastExit, null, 'a restart is not an unexpected exit');
  });
});

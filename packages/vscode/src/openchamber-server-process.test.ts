import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServerEnvironment, launchOpenChamberServer, type ServerLaunchOptions } from './openchamber-server-process';

// A stand-in for dist/openchamber-server/server.mjs that speaks the same IPC
// protocol. FIXTURE_MODE picks its behaviour; every process it starts writes
// its pid to FIXTURE_MARKER so the test can check that none survives.
const FIXTURE = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.env.FIXTURE_MODE;
const record = (pid) => fs.appendFileSync(process.env.FIXTURE_MARKER, pid + '\\n');
record(process.pid);
if (process.env.FIXTURE_DESCENDANT === '1') {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  record(descendant.pid);
}
const keepAlive = setInterval(() => {}, 1000);
const stopOnRequest = () => process.on('message', (message) => {
  if (message && message.type === 'stop') setTimeout(() => process.exit(0), 20);
});
console.log('fixture output before startup settled');
if (mode === 'ready') {
  stopOnRequest();
  process.send({ type: 'ready', port: 4567 });
} else if (mode === 'ready-ignores-stop') {
  process.on('SIGTERM', () => {});
  process.send({ type: 'ready', port: 4568 });
} else if (mode === 'malformed-then-ready') {
  stopOnRequest();
  process.send({ type: 'ready', port: 'not-a-port' });
  process.send({ unrelated: true });
  setTimeout(() => process.send({ type: 'ready', port: 4569 }), 20);
} else if (mode === 'failed') {
  process.send({ type: 'failed', message: 'listen EADDRINUSE' }, () => process.exit(1));
} else if (mode === 'exit-early') {
  process.exit(3);
} else if (mode === 'crash-after-ready') {
  process.send({ type: 'ready', port: 4570 });
  setTimeout(() => process.exit(7), 50);
}
void keepAlive;
`;

let directory = '';
let scriptPath = '';

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-server-'));
  scriptPath = path.join(directory, 'fixture.cjs');
  await fs.writeFile(scriptPath, FIXTURE);
});

after(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

// A killed descendant is a zombie until its new parent reaps it, and some
// container init processes never do. It has exited all the same.
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return !state.startsWith('Z');
};

const readPids = async (marker: string) => (await fs.readFile(marker, 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(Number);

const waitUntilGone = async (pids: number[]) => {
  for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pids.filter(alive);
};

const launch = (mode: string, overrides: Partial<ServerLaunchOptions> & { descendant?: boolean } = {}) => {
  const marker = path.join(directory, `${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}.pids`);
  const { descendant, ...options } = overrides;
  const started = launchOpenChamberServer({
    execPath: process.execPath,
    scriptPath,
    cwd: directory,
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_MARKER: marker, FIXTURE_DESCENDANT: descendant ? '1' : '0' },
    timeoutMs: 10_000,
    shutdownGraceMs: 300,
    signal: new AbortController().signal,
    ...options,
  });
  return { marker, started };
};

describe('launchOpenChamberServer', () => {
  test('resolves with the loopback URL of the port the server reports', async () => {
    const { started } = launch('ready');
    const server = await started;
    try {
      assert.equal(server.url, 'http://127.0.0.1:4567');
    } finally {
      await server.close();
    }
  });

  test('stops the server with a stop message and settles exited', async () => {
    const { marker, started } = launch('ready');
    const server = await started;
    await Promise.all([server.close(), server.close()]);
    const exit = await server.exited;
    assert.equal(exit.code, 0);
    assert.deepEqual(await waitUntilGone(await readPids(marker)), []);
  });

  test('kills a server and its descendants that ignore the stop request', async () => {
    const { marker, started } = launch('ready-ignores-stop', { descendant: true });
    const server = await started;
    const pids = await readPids(marker);
    assert.equal(pids.length, 2, 'the server and its descendant run');
    await server.close();
    assert.deepEqual(await waitUntilGone(pids), []);
  });

  test('ignores messages outside the protocol', async () => {
    const { started } = launch('malformed-then-ready');
    const server = await started;
    try {
      assert.equal(server.url, 'http://127.0.0.1:4569');
    } finally {
      await server.close();
    }
  });

  test('settles exited when a ready server stops on its own', async () => {
    const { started } = launch('crash-after-ready');
    const server = await started;
    const exit = await server.exited;
    assert.equal(exit.code, 7);
    await server.close();
  });

  test('rejects with the reason and the output when the server reports a failed start', async () => {
    const { marker, started } = launch('failed');
    await assert.rejects(started, (error: Error) => {
      assert.match(error.message, /failed to start: listen EADDRINUSE/);
      assert.match(error.message, /fixture output before startup settled/);
      return true;
    });
    assert.deepEqual(await waitUntilGone(await readPids(marker)), []);
  });

  test('rejects when the server exits before it is ready', async () => {
    const { started } = launch('exit-early');
    await assert.rejects(started, /exited before it was ready \(exit code 3\)/);
  });

  test('kills a server that never reports within the timeout', async () => {
    const { marker, started } = launch('silent', { timeoutMs: 500, descendant: true });
    await assert.rejects(started, /did not start within 500ms/);
    assert.deepEqual(await waitUntilGone(await readPids(marker)), []);
  });

  test('kills a starting server when startup is cancelled', async () => {
    const controller = new AbortController();
    const { marker, started } = launch('silent', { signal: controller.signal, descendant: true });
    for (let attempt = 0; attempt < 200 && (await readPids(marker)).length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await assert.rejects(started, /startup cancelled/);
    assert.deepEqual(await waitUntilGone(await readPids(marker)), []);
  });

  test('does not spawn when startup was cancelled before launch', async () => {
    const { marker, started } = launch('ready', { signal: AbortSignal.abort() });
    await assert.rejects(started);
    assert.deepEqual(await readPids(marker), []);
  });
});

describe('buildServerEnvironment', () => {
  test('marks the server as the VS Code runtime without a relay and runs the binary as Node', () => {
    const env = buildServerEnvironment({ PATH: '/usr/bin', OPENCHAMBER_RELAY_HOST: 'on' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.OPENCHAMBER_RUNTIME, 'vscode');
    assert.equal(env.OPENCHAMBER_RELAY_HOST, 'off');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    // Recorded as injected, so a shell the server opens can tell them from the user's exports.
    assert.deepEqual(env.OPENCHAMBER_INJECTED_ENV?.split(',').sort(), ['OPENCHAMBER_RELAY_HOST', 'OPENCHAMBER_RUNTIME', 'OPENCHAMBER_SKIP_API_COMPRESSION']);
  });
});

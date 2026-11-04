import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, access } from 'node:fs/promises';
import { OpenCodeService } from './service.js';

test('service starts once, scopes MCP config, hides Windows child and removes config on stop', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  const spawns = [];
  const service = new OpenCodeService({
    cwd: process.cwd(), toolServer: { name: 'openchamber', url: 'http://127.0.0.1:1234/mcp', token: 'test-token' },
    resolveExecutable: async () => ({ command: 'fake', isWindows: true }),
    spawnProcess: (binary, args, options) => {
      spawns.push({ binary, args, options });
      queueMicrotask(() => child.stdout.write('Listening on http://127.0.0.1:4444\n'));
      return child;
    },
    stopChild: async () => { child.exitCode = 0; child.emit('exit', 0); },
  });
  await Promise.all([service.start(), service.start()]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(service.baseUrl, 'http://127.0.0.1:4444');
  const configPath = spawns[0].options.env.OPENCODE_CONFIG;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.mcp.servers.openchamber.headers.Authorization, 'Bearer test-token');
  await service.stop();
  await assert.rejects(access(configPath));
});

test('startup failure stops owned child and never reveals raw logs', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  let stopped = 0;
  const service = new OpenCodeService({ cwd: process.cwd(), startupMs: 10,
    resolveExecutable: async () => ({ command: 'fake', isWindows: false }),
    spawnProcess: () => child,
    stopChild: async () => { stopped++; child.exitCode = 1; child.emit('exit', 1); },
  });
  await assert.rejects(service.start(), /startup timed out/);
  assert.equal(stopped, 1);
});

test('shutdown during binary discovery cannot spawn a late child', async () => {
  let resolveBinary;
  let spawned = false;
  const service = new OpenCodeService({ cwd: process.cwd(),
    resolveExecutable: () => new Promise((resolve) => { resolveBinary = resolve; }),
    spawnProcess: () => { spawned = true; throw new Error('Late child spawned'); },
  });
  const starting = service.start();
  const rejected = assert.rejects(starting, /stopped during startup/);
  await service.stop();
  resolveBinary({ command: 'fake', isWindows: false });
  await rejected;
  assert.equal(spawned, false);
});

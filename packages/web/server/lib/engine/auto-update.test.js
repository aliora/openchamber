import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineAutoUpdater } from './auto-update.js';
import { createEngineRegistry } from './registry.js';
import { registerEngineRoutes } from './routes.js';
import { LocalSessionStore } from './store.js';
import { CliInstaller } from './cli-installer.js';
import { createFakeEngine } from './test/fake-engine.js';
import { createFakeSpawn } from './test/fake-cli.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const silentLogger = { info() {}, error() {} };

const createCliEngine = ({ detection, spawn, tmpDir }) => {
  const engine = createFakeEngine({ id: 'cli' });
  engine.installer = new CliInstaller(
    { packageName: '@example/cli', detect: () => detection.current },
    { platform: 'linux', env: { HOME: tmpDir }, home: tmpDir, fileExists: () => false, fetchLatest: async () => '2.0.0', spawnProcess: spawn.spawnProcess },
  );
  return engine;
};

const DAY = 24 * 60 * 60 * 1000;

describe('engine auto updater', () => {
  let tmpDir;
  let spawn;
  let detection;
  let engine;
  let stored;
  let busy;
  let clock;
  let updater;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auto-update-test-'));
    spawn = createFakeSpawn();
    detection = { current: { installed: true, version: '1.0.0', command: '/prefix/bin/cli', managedByNpm: true } };
    engine = createCliEngine({ detection, spawn, tmpDir });
    stored = { cli: { enabled: true, interval: 'daily', lastCheckAt: null } };
    busy = false;
    clock = 10 * DAY;
    updater = createEngineAutoUpdater({
      registry: createEngineRegistry([engine]),
      store: { read: async () => stored, save: async (value) => { stored = value; } },
      isEngineBusy: () => busy,
      now: () => clock,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const finishUpdate = async (code = 0) => {
    await settle();
    if (code === 0) detection.current = { ...detection.current, version: '2.0.0' };
    spawn.finish(code);
    await settle();
  };

  it('runs the engine update when a newer version exists and keeps when it checked', async () => {
    const check = updater.tick();
    await finishUpdate();
    await check;
    expect(spawn.calls[0].args).toEqual(['install', '-g', '@example/cli@latest']);
    expect(updater.describe('cli')).toMatchObject({ ok: true, from: '1.0.0', to: '2.0.0', error: null });
    expect(stored.cli).toEqual({ enabled: true, interval: 'daily', lastCheckAt: clock });
  });

  it('waits for the interval before the next check', async () => {
    detection.current = { ...detection.current, version: '2.0.0' };
    await updater.tick();
    expect(stored.cli.lastCheckAt).toBe(clock);

    detection.current = { ...detection.current, version: '1.0.0' };
    engine.installer._cachedDetection = null;
    clock += DAY - 1000;
    await updater.tick();
    expect(spawn.calls).toHaveLength(0);

    clock += 2000;
    const due = updater.tick();
    await finishUpdate();
    await due;
    expect(spawn.calls).toHaveLength(1);
  });

  it('uses the weekly and monthly intervals', async () => {
    stored = { cli: { enabled: true, interval: 'weekly', lastCheckAt: clock } };
    clock += 6 * DAY;
    await updater.tick();
    expect(spawn.calls).toHaveLength(0);
    stored = { cli: { enabled: true, interval: 'monthly', lastCheckAt: clock - 29 * DAY } };
    await updater.tick();
    expect(spawn.calls).toHaveLength(0);
  });

  it('does nothing while the switch is off', async () => {
    stored = { cli: { enabled: false, interval: 'daily', lastCheckAt: null } };
    await updater.tick();
    expect(spawn.calls).toHaveLength(0);
    expect(stored.cli.lastCheckAt).toBeNull();
  });

  it('does not update during an open turn and tries again on the next poll', async () => {
    busy = true;
    await updater.tick();
    expect(spawn.calls).toHaveLength(0);
    expect(stored.cli.lastCheckAt).toBeNull();

    busy = false;
    const retry = updater.tick();
    await finishUpdate();
    await retry;
    expect(spawn.calls).toHaveLength(1);
  });

  it('keeps a failure visible and waits for the next interval', async () => {
    const first = updater.tick();
    await finishUpdate(1);
    await first;
    expect(updater.describe('cli')).toMatchObject({ ok: false, to: '2.0.0' });
    expect(updater.describe('cli').error).toContain('exited with code 1');
    expect(stored.cli.lastCheckAt).toBe(clock);

    await updater.tick();
    expect(spawn.calls).toHaveLength(1);
  });
});

describe('auto update routes', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let stored;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auto-update-routes-test-'));
    stored = {};
    const engine = createCliEngine({
      detection: { current: { installed: true, version: '2.0.0', command: '/prefix/bin/cli', managedByNpm: true } },
      spawn: createFakeSpawn(),
      tmpDir,
    });
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry: createEngineRegistry([engine]),
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      autoUpdateSetting: { read: async () => stored, save: async (value) => { stored = value; } },
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const put = (body) => fetch(`${baseUrl}/api/engines/cli/auto-update`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('stores the switch and the interval per engine and reports them on the status', async () => {
    const off = (await (await fetch(`${baseUrl}/api/engines/cli/status`)).json()).autoUpdate;
    expect(off).toEqual({ enabled: false, interval: 'daily', lastCheckAt: null, nextCheckAt: null, lastRun: null });

    const on = await put({ enabled: true });
    expect(on.status).toBe(200);
    expect((await on.json()).autoUpdate).toMatchObject({ enabled: true, interval: 'daily' });
    expect(stored).toEqual({ cli: { enabled: true, interval: 'daily', lastCheckAt: null } });

    const weekly = await (await put({ interval: 'weekly' })).json();
    expect(weekly.autoUpdate).toMatchObject({ enabled: true, interval: 'weekly' });
    stored = { cli: { ...stored.cli, lastCheckAt: 1_000 } };
    expect((await (await fetch(`${baseUrl}/api/engines/cli/status`)).json()).autoUpdate).toMatchObject({ lastCheckAt: 1_000, nextCheckAt: 1_000 + 7 * DAY });

    await put({ enabled: false });
    expect(stored.cli).toMatchObject({ enabled: false, interval: 'weekly' });
  });

  it('rejects a bad switch or interval and an unknown engine', async () => {
    expect((await put({ enabled: 'yes' })).status).toBe(400);
    expect((await put({ interval: 'hourly' })).status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/engines/nope/auto-update`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
    expect(missing.status).toBe(404);
  });
});

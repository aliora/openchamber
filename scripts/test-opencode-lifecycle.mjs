// Integration test of the OpenCode engine's setup flows against the real CLI and the real engine routes:
// install, sign-in and sign-out (credentials), models after each, update, reinstall and uninstall.
// Everything runs in a throwaway HOME and npm prefix; the machine's own OpenCode is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createOpenCodeEngine } from '../packages/web/server/lib/engine/opencode/adapter.js';
import { OpenCodeInstaller } from '../packages/web/server/lib/engine/opencode/installer.js';
import { createFakeEngine } from '../packages/web/server/lib/engine/test/fake-engine.js';
import { createEngineRegistry } from '../packages/web/server/lib/engine/registry.js';
import { registerEngineRoutes } from '../packages/web/server/lib/engine/routes.js';
import { LocalSessionStore } from '../packages/web/server/lib/engine/store.js';
import { StreamHub } from '../packages/web/server/lib/engine/stream-hub.js';

const OLDER_VERSION = '2.0.31';
const isWindows = process.platform === 'win32';
const root = await mkdtemp(path.join(os.tmpdir(), 'oc-lifecycle-'));
const home = path.join(root, 'home');
const appData = path.join(home, 'AppData', 'Roaming');
const prefix = isWindows ? path.join(appData, 'npm') : path.join(home, '.npm-prefix');
const binDir = isWindows ? prefix : path.join(prefix, 'bin');
const workDirectory = path.join(root, 'work');
for (const dir of [home, appData, prefix, binDir, workDirectory]) await mkdir(dir, { recursive: true });

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
  npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix,
  [pathKey]: [binDir, ...process.env[pathKey].split(path.delimiter).filter((entry) => !/\.opencode/i.test(entry))].join(path.delimiter),
};
for (const key of ['OPENCODE_BINARY', 'OPENCODE_PATH', 'OPENCHAMBER_OPENCODE_PATH']) delete env[key];

const results = {};
const step = (name) => console.log(`\n== ${name}`);
const pass = (name) => { results[name] = true; console.log(`   ok: ${name}`); };
const until = async (read, done, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

const engine = createOpenCodeEngine({
  installer: new OpenCodeInstaller({ env, home, getEnvironment: async () => env }),
  getEnvironment: async () => env,
});
const app = express(); app.use(express.json());
const runtime = registerEngineRoutes(app, {
  registry: createEngineRegistry([createFakeEngine({ id: 'claude' }), engine]),
  store: new LocalSessionStore({ storagePath: path.join(root, 'sessions.json') }),
  streamHub: new StreamHub(),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const api = async (method, route, body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(workDirectory) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* A plain-text reply has no JSON. */ }
  return { status: response.status, json, text };
};
const status = async () => (await api('GET', '/api/engines/opencode/status?refresh=true')).json;
const readReadiness = async () => (await api('GET', '/api/engines/readiness')).json.data.find((entry) => entry.engine === 'opencode');
// Readiness is worked out in the background, so the first answers can be `unknown`.
const readiness = () => until(readReadiness, (entry) => entry.state !== 'unknown', 60000, 'the readiness check');
const runAction = async (action) => {
  const started = await api('POST', `/api/engines/opencode/actions/${action}`, {});
  assert.equal(started.status, 202, `${action}: ${started.text}`);
  const finished = await until(status, (value) => value.state === 'completed' || value.state === 'failed', 600000, `${action} to finish`);
  assert.notEqual(finished.state, 'failed', `${action} failed: ${finished.lastError}`);
  return finished;
};
const cli = (args) => spawnSync(cliCommand, args, { env, encoding: 'utf8', shell: isWindows && cliCommand.endsWith('.cmd'), timeout: 120000, input: '' });
const modelsOf = async (provider) => {
  await api('POST', '/api/engines/opencode/models/refresh');
  const list = (await api('GET', '/api/model')).json;
  const models = list?.data ?? list ?? [];
  return models.filter((model) => String(model.id ?? model.modelID).startsWith(`${provider}/`));
};
const npm = (args) => {
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { env, encoding: 'utf8', shell: isWindows, timeout: 600000 });
  assert.equal(result.status, 0, `npm ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
let cliCommand = null;

try {
  const latest = npm(['view', '@opencode/cli', 'version']);
  console.log(`latest @opencode/cli: ${latest}`);

  step('1. nothing installed yet');
  const fresh = await status();
  assert.equal(fresh.installed, false);
  assert.equal(fresh.canInstall, true);
  assert.match(fresh.installCommand, /npm install -g @opencode\/cli@latest/);
  assert.equal((await readiness()).state, 'not-installed');
  pass('not installed: install offered, readiness not-installed');

  step('2. install from the engine route');
  const installed = await runAction('install');
  assert.equal(installed.installed, true, JSON.stringify(installed).slice(0, 500));
  assert.equal(installed.version, latest);
  assert.equal(installed.installSource, 'npm');
  assert.equal(installed.updateAvailable, false);
  cliCommand = installed.command;
  pass(`install: ${installed.version} via npm at ${installed.command}`);

  step('3. engine works on the installed CLI (full e2e as a child process)');
  const e2e = spawnSync(process.execPath, [path.join(import.meta.dirname, 'test-opencode-engine-e2e.mjs')], { env, encoding: 'utf8', timeout: 400000 });
  assert.equal(e2e.status, 0, `${e2e.stdout}\n${e2e.stderr}`.slice(-1500));
  const summary = JSON.parse(e2e.stdout.trim().split('\n').pop());
  assert(Object.values(summary).every(Boolean), JSON.stringify(summary));
  pass(`e2e on ${latest}: ${Object.keys(summary).join(', ')}`);

  step('4. signed out: free models only');
  const freeModels = await modelsOf('opencode');
  assert(freeModels.length > 0, 'no free OpenCode models');
  assert.equal((await modelsOf('openrouter')).length, 0);
  assert.equal((await api('GET', '/api/engines/opencode/auth/status')).json.loggedIn, true);
  assert.equal((await readiness()).state, 'ready');
  pass(`free models: ${freeModels.length}; readiness ready`);

  step('5. sign in (credential import, the CLI form without a terminal)');
  const credentialFile = path.join(root, 'credential.json');
  await writeFile(credentialFile, JSON.stringify([{ id: 'crd_lifecycle_test', integrationID: 'openrouter', label: 'LifecycleTest', active: true, value: { type: 'key', key: 'sk-or-FAKE-lifecycle-test' } }]));
  const imported = cli(['auth', 'import', credentialFile, '--standalone']);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.match(cli(['auth', 'list', '--standalone']).stdout, /OpenRouter\s+LifecycleTest/);
  const afterLogin = await modelsOf('openrouter');
  assert(afterLogin.length > 0, 'the engine catalog did not pick up the new provider');
  pass(`sign in: ${afterLogin.length} OpenRouter models appear after the model refresh`);

  step('6. the UI sign-in and sign-out routes answer with the terminal step');
  const login = await api('POST', '/api/engines/opencode/auth/login');
  assert.equal(login.status, 501);
  assert.match(login.json.error, /opencode auth login/);
  const logoutRoute = await api('POST', '/api/engines/opencode/auth/logout');
  assert.notEqual(logoutRoute.status, 200);
  assert.match(logoutRoute.text, /opencode auth logout/);
  pass('login route 501 and logout route name the terminal commands');

  step('7. sign out (CLI) and the catalog follows');
  const loggedOut = cli(['auth', 'logout', 'openrouter', 'LifecycleTest', '--standalone']);
  assert.equal(loggedOut.status, 0, loggedOut.stdout + loggedOut.stderr);
  assert.equal((await modelsOf('openrouter')).length, 0);
  assert.match(cli(['auth', 'list', '--standalone']).stdout, /No authenticated integrations/);
  pass('sign out: OpenRouter models gone after the model refresh');

  step(`8. update from ${OLDER_VERSION}`);
  npm(['install', '-g', `@opencode/cli@${OLDER_VERSION}`]);
  const older = await status();
  assert.equal(older.version, OLDER_VERSION);
  assert.equal(older.updateAvailable, true);
  assert.equal(older.actions.update, true);
  const updated = await runAction('update');
  assert.equal(updated.version, latest, JSON.stringify(updated).slice(0, 500));
  assert.equal(updated.updateAvailable, false);
  pass(`update: ${OLDER_VERSION} -> ${updated.version}`);

  step('9. reinstall');
  const reinstalled = await runAction('reinstall');
  assert.equal(reinstalled.installed, true);
  assert.equal(reinstalled.version, latest);
  pass('reinstall keeps the CLI installed');

  step('10. uninstall');
  const removed = await runAction('uninstall');
  assert.equal(removed.installed, false, JSON.stringify(removed).slice(0, 500));
  assert.equal((await readiness()).state, 'not-installed');
  pass('uninstall: not installed again');

  console.log(`\n${JSON.stringify({ ok: true, latest, steps: Object.keys(results).length })}`);
} catch (error) {
  console.error('\nFAILED:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await runtime.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portIndex = process.argv.indexOf('--port');
const port = portIndex > 0 ? process.argv[portIndex + 1] : '3000';
const base = `http://127.0.0.1:${port}`;

const SMOKE_MODELS = { claude: 'anthropic/haiku', codex: 'openai/gpt-5.6-luna', antigravity: 'google/default' };
const PROMPT = 'Reply with exactly: PONG';
const READINESS_WAIT_SECONDS = 15;

const getJson = async (url) => (await fetch(`${base}${url}`)).json();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readReadiness = async () => (await getJson('/api/engines/readiness')).data;

const waitForReadiness = async () => {
  let entries = await readReadiness();
  for (let second = 0; second < READINESS_WAIT_SECONDS && entries.some((entry) => entry.state === 'unknown'); second += 1) {
    await sleep(1000);
    entries = await readReadiness();
  }
  return entries;
};

const runTurn = (model, directory) => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'packages/web/bin/cli.js'), 'session', 'create', '-p', port,
    '--dir', directory, '--title', `smoke ${model}`, '--prompt', PROMPT,
    '--model', model, '--wait', '--last-assistant', '--timeout', '200', '--json',
  ], { encoding: 'utf8', timeout: 240000, env: process.env });
  try {
    return JSON.parse(result.stdout).lastAssistantMessage?.text?.trim() ?? null;
  } catch {
    return null;
  }
};

let engines;
let readinessEntries;
try {
  engines = (await getJson('/api/engines')).data;
  readinessEntries = await waitForReadiness();
} catch {
  console.error(`engine-smoke: cannot reach OpenChamber server at ${base} (is it running?)`);
  process.exit(1);
}

const readiness = new Map(readinessEntries.map((entry) => [entry.engine, entry.state]));
const directory = mkdtempSync(path.join(os.tmpdir(), 'oc-engine-smoke-'));

const rows = engines.map((engine) => {
  const state = readiness.get(engine.engine) ?? 'unknown';
  const answer = state === 'ready' ? runTurn(SMOKE_MODELS[engine.engine], directory) : null;
  return {
    engine: engine.engine,
    installed: engine.installed,
    version: engine.version ?? '-',
    latest: engine.latestVersion ?? '-',
    readiness: state,
    turn: answer === 'PONG' ? 'PONG' : (answer ?? 'skipped'),
  };
});

console.table(rows);
process.exit(rows.every((row) => row.turn === 'PONG') ? 0 : 1);

import os from 'node:os';
import { terminateChild } from '../cli-platform.js';
import { JsonRpcConnection } from './json-rpc.js';
import { spawnCodexProcess } from './platform.js';
import { modelListResponseSchema } from './protocol.js';

// The models the Codex engine offers, read from the installed CLI through
// `model/list` of `codex app-server`. A request never waits for a read: the
// catalog answers the list the last successful read returned, or the list
// below until one succeeds. ../DOCUMENTATION.md, *The Codex adapter*, says
// when it reads again.

/**
 * What `model/list` returned in codex-cli 0.163.0, the CLI's default first.
 * Served until a read of the installed CLI succeeds: before the first read
 * finishes, without the CLI, and when every read failed. These models take
 * the adapter's efforts.
 */
export const CODEX_FALLBACK_CATALOG = {
  models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', family: 'gpt-sol' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', family: 'gpt-astra' },
    { id: 'gpt-6-sol', name: 'GPT-6-Sol', family: 'gpt-sol' },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', family: 'gpt-luna' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', family: 'gpt-sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', family: 'gpt-terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', family: 'gpt-luna' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
  ],
  defaultModel: 'gpt-6.1-sol',
};

// The list is read again after 10 minutes, and as soon as another Codex
// binary or version is installed.
const READ_TTL_MS = 10 * 60_000;
// How often serving the catalog may look up the installed binary and version.
const IDENTITY_CHECK_MS = 30_000;
// A read that takes longer fails, and its app-server is stopped.
const READ_TIMEOUT_MS = 15_000;

/**
 * The catalog of the models `model/list` returned, each with its own efforts,
 * or null when none could be read. The default is the model Codex marks as
 * its own, else the first.
 */
const toCodexModelCatalog = (listed) => {
  const models = listed.filter(Boolean);
  if (models.length === 0) return null;
  return {
    models: models.map((model) => ({
      id: model.model,
      name: model.displayName,
      efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    })),
    defaultModel: (models.find((model) => model.isDefault) ?? models[0]).model,
  };
};

/**
 * Starts `codex app-server`, reads every page of `model/list` and stops the
 * process. Resolves with the catalog; rejects when the CLI does not start,
 * fails the request, takes longer than `timeoutMs` or lists no model.
 * `model/list` needs no signed-in account.
 */
export const readCodexModels = async ({ spawnProcess = spawnCodexProcess, clientVersion, timeoutMs = READ_TIMEOUT_MS }) => {
  // The list does not depend on a project, so the read runs from the home folder.
  const child = spawnProcess(['app-server'], { cwd: os.homedir() });
  const rpc = new JsonRpcConnection(child.stdout, child.stdin);
  // Codex logs to stderr. Reading it keeps the pipe from filling up.
  child.stderr.resume();
  child.stdin.on('error', (error) => rpc.close(error));
  child.on('error', (error) => rpc.close(error));
  child.on('exit', (code, signal) => rpc.close(new Error(`Codex app-server exited (${signal || code})`)));
  const timer = setTimeout(() => {
    rpc.close(new Error(`Codex did not list its models within ${timeoutMs / 1000} seconds`));
  }, timeoutMs);

  try {
    // `initialize` fails without `clientInfo.version`.
    await rpc.request('initialize', {
      clientInfo: { name: 'openchamber', title: 'OpenChamber', version: clientVersion || 'unknown' },
      capabilities: null,
    });
    rpc.notify('initialized');
    const listed = [];
    let cursor = null;
    do {
      const page = modelListResponseSchema.parse(await rpc.request('model/list', { cursor }));
      listed.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    const catalog = toCodexModelCatalog(listed);
    if (!catalog) throw new Error('Codex listed no models');
    return catalog;
  } finally {
    clearTimeout(timer);
    rpc.close(new Error('The model list was read'));
    void terminateChild(child);
  }
};

/**
 * The model catalog the Codex adapter serves. `current()` answers at once
 * with the list of the last successful read, else `fallback`. After
 * `start()`, which reads at once, a call also checks in the background
 * whether to read again: when `ttlMs` passed since the last read, or when
 * `identify()` names another binary and version than it did then. `identify()`
 * runs at most every `checkIntervalMs` and only after the answer went out,
 * because finding the binary can block. Nothing is read while it answers null
 * (no CLI). One read runs at a time, and a failed one keeps what was served.
 */
export const createCodexModelCatalog = ({
  read,
  identify,
  fallback = CODEX_FALLBACK_CATALOG,
  ttlMs = READ_TTL_MS,
  checkIntervalMs = IDENTITY_CHECK_MS,
  now = Date.now,
  warn = console.warn,
}) => {
  let started = false;
  let served = fallback;
  // The binary and version the last read ran against, and when it started.
  let lastRead = null;
  let checkedAt = -Infinity;
  let checking = null;

  const readIfStale = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    checkedAt = now();
    const identity = identify();
    if (identity === null) return;
    if (lastRead && lastRead.identity === identity && checkedAt - lastRead.at < ttlMs) return;
    lastRead = { identity, at: checkedAt };
    served = await read();
  };

  const check = () => {
    checking ??= readIfStale()
      .catch((error) => warn(`[engine:codex] Could not read the model list: ${error?.message ?? error}`))
      .finally(() => { checking = null; });
    return checking;
  };

  return {
    current: () => {
      if (started && now() - checkedAt >= checkIntervalMs) void check();
      return served;
    },
    /** Reads the list now; later calls to `current()` keep it fresh. Resolves once that read settled. */
    start: () => {
      started = true;
      return check();
    },
  };
};

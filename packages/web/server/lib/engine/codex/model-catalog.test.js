import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import { createFakeCodexChild, readCodexTranscript } from '../test/fake-codex.js';
import { createFakeEngine } from '../test/fake-engine.js';
import { createCodexEngine } from './adapter.js';
import { CODEX_FALLBACK_CATALOG, createCodexModelCatalog, readCodexModels } from './model-catalog.js';

const INITIALIZED = [
  { await: 'initialize' },
  { id: 1, result: { userAgent: 'openchamber/0.163.0', codexHome: '/home/dev/.codex', platformFamily: 'unix', platformOs: 'linux' } },
  { await: 'initialized' },
];

/** A `model/list` entry as codex-cli 0.163.0 sends it, trimmed to the fields that matter here. */
const listed = (model, efforts, isDefault = false) => ({
  id: model,
  model,
  displayName: model.toUpperCase(),
  description: '',
  hidden: false,
  isDefault,
  defaultReasoningEffort: efforts[0],
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
});

/** `readCodexModels` on a fake app-server playing `transcript`. */
const readFrom = (transcript, options = {}) => {
  const spawns = [];
  const child = createFakeCodexChild(transcript);
  const result = readCodexModels({
    clientVersion: '1.0.0',
    spawnProcess: (args, spawnOptions) => {
      spawns.push({ args, options: spawnOptions });
      return child;
    },
    ...options,
  });
  return { result, child, spawns };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const LIVE = {
  models: [{ id: 'gpt-7-nova', name: 'GPT-7-Nova', efforts: ['low', 'medium', 'max'] }],
  defaultModel: 'gpt-7-nova',
};

describe('readCodexModels', () => {
  it('reads the models codex-cli 0.163.0 lists, each with its own efforts, and stops the app-server', async () => {
    const { result, child, spawns } = readFrom(readCodexTranscript('model-list'));
    const catalog = await result;

    expect(spawns).toEqual([{ args: ['app-server'], options: { cwd: os.homedir() } }]);
    expect(child.sent.map((message) => message.method)).toEqual(['initialize', 'initialized', 'model/list']);
    expect(child.sent[0].params).toEqual({ clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '1.0.0' }, capabilities: null });
    expect(child.sent[2].params).toEqual({ cursor: null });
    expect(child.finished).toBe(true);
    expect(child.killed).toBe(true);

    expect(catalog.defaultModel).toBe('gpt-6.1-sol');
    expect(catalog.models.map((model) => [model.id, model.name])).toEqual([
      ['gpt-6.1-sol', 'GPT-6.1-Sol'],
      ['gpt-6-astra', 'GPT-6-Astra'],
      ['gpt-6-sol', 'GPT-6-Sol'],
      ['gpt-6-luna', 'GPT-6-Luna'],
      ['gpt-5.6-sol', 'GPT-5.6-Sol'],
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-5.6-luna', 'GPT-5.6-Luna'],
      ['gpt-5.5', 'GPT-5.5'],
    ]);
    const effortsOf = (id) => catalog.models.find((model) => model.id === id).efforts;
    expect(effortsOf('gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsOf('gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsOf('gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('follows the cursor to the last page and leaves out a model it cannot read', async () => {
    const { result, child } = readFrom([
      ...INITIALIZED,
      { await: 'model/list' },
      { id: 2, result: { data: [listed('gpt-7-nova', ['low', 'high']), { id: 'broken', model: 'broken' }], nextCursor: 'page-2' } },
      { await: 'model/list' },
      { id: 3, result: { data: [listed('gpt-7-sol', ['medium'], true)], nextCursor: null } },
    ]);
    const catalog = await result;

    expect(child.sent.filter((message) => message.method === 'model/list').map((message) => message.params))
      .toEqual([{ cursor: null }, { cursor: 'page-2' }]);
    expect(catalog).toEqual({
      models: [
        { id: 'gpt-7-nova', name: 'GPT-7-NOVA', efforts: ['low', 'high'] },
        { id: 'gpt-7-sol', name: 'GPT-7-SOL', efforts: ['medium'] },
      ],
      defaultModel: 'gpt-7-sol',
    });
  });

  it('fails when Codex refuses the request or lists no model, and stops the app-server either way', async () => {
    const refused = readFrom([
      ...INITIALIZED,
      { await: 'model/list' },
      { id: 2, error: { code: -32603, message: 'model catalog unavailable' } },
    ]);
    await expect(refused.result).rejects.toThrow('model catalog unavailable');
    expect(refused.child.killed).toBe(true);

    const empty = readFrom([...INITIALIZED, { await: 'model/list' }, { id: 2, result: { data: [] } }]);
    await expect(empty.result).rejects.toThrow('Codex listed no models');
    expect(empty.child.killed).toBe(true);
  });

  it('fails when the app-server does not answer in time or cannot start', async () => {
    // The transcript never answers `initialize`.
    const silent = readFrom([{ await: 'initialize' }], { timeoutMs: 30 });
    await expect(silent.result).rejects.toThrow('Codex did not list its models within 0.03 seconds');
    expect(silent.child.killed).toBe(true);

    const child = createFakeCodexChild([{ await: 'initialize' }]);
    const missing = readCodexModels({ clientVersion: '1.0.0', spawnProcess: () => child });
    child.emit('error', new Error('spawn codex ENOENT'));
    await expect(missing).rejects.toThrow('spawn codex ENOENT');
  });
});

describe('createCodexModelCatalog', () => {
  /** A catalog with a clock, an installed binary and reads the test settles. */
  const setup = ({ reads = [] } = {}) => {
    const state = { clock: 1_000, identity: '/usr/local/bin/codex 0.163.0', reads: 0, identified: 0, warnings: [] };
    const catalog = createCodexModelCatalog({
      read: async () => {
        state.reads += 1;
        const next = reads.shift() ?? LIVE;
        if (next instanceof Error) throw next;
        return next;
      },
      identify: () => {
        state.identified += 1;
        return state.identity;
      },
      ttlMs: 600_000,
      checkIntervalMs: 30_000,
      now: () => state.clock,
      warn: (message) => state.warnings.push(message),
    });
    return { catalog, state };
  };

  it('serves the fallback list until started, then the list the CLI reported', async () => {
    const { catalog, state } = setup();

    expect(catalog.current()).toBe(CODEX_FALLBACK_CATALOG);
    await settle();
    // Nothing reads the CLI before the server starts the catalog.
    expect(state).toMatchObject({ reads: 0, identified: 0 });

    await catalog.start();
    expect(state.reads).toBe(1);
    expect(catalog.current()).toBe(LIVE);
  });

  it('keeps serving what it had when a read fails', async () => {
    const newer = { ...LIVE, defaultModel: 'gpt-7-nova' };
    const { catalog, state } = setup({ reads: [new Error('spawn codex ENOENT'), newer, new Error('timed out')] });

    await catalog.start();
    expect(catalog.current()).toBe(CODEX_FALLBACK_CATALOG);
    expect(state.warnings).toEqual(['[engine:codex] Could not read the model list: spawn codex ENOENT']);

    state.clock += 600_000;
    catalog.current();
    await settle();
    expect(catalog.current()).toBe(newer);

    state.clock += 600_000;
    catalog.current();
    await settle();
    expect(state.reads).toBe(3);
    expect(catalog.current()).toBe(newer);
  });

  it('reads again after the TTL or when another binary or version is installed, one read at a time', async () => {
    const { catalog, state } = setup();
    await catalog.start();
    expect(state).toMatchObject({ reads: 1, identified: 1 });

    // Within the check interval nothing is looked up.
    state.clock += 29_999;
    catalog.current();
    await settle();
    expect(state).toMatchObject({ reads: 1, identified: 1 });

    // The same binary within the TTL is not read again.
    state.clock += 1;
    catalog.current();
    await settle();
    expect(state).toMatchObject({ reads: 1, identified: 2 });

    // A Codex upgrade is read at the next check, however many requests ask.
    state.identity = '/usr/local/bin/codex 0.164.0';
    state.clock += 30_000;
    catalog.current();
    catalog.current();
    catalog.current();
    await settle();
    expect(state).toMatchObject({ reads: 2, identified: 3 });

    // The TTL alone also reads again.
    state.clock += 600_000;
    catalog.current();
    await settle();
    expect(state.reads).toBe(3);
  });

  it('reads nothing while the CLI is missing, and reads once it appears', async () => {
    const { catalog, state } = setup();
    state.identity = null;

    await catalog.start();
    expect(state.reads).toBe(0);
    expect(catalog.current()).toBe(CODEX_FALLBACK_CATALOG);

    state.identity = '/usr/local/bin/codex 0.163.0';
    state.clock += 30_000;
    catalog.current();
    await settle();
    expect(state.reads).toBe(1);
    expect(catalog.current()).toBe(LIVE);
  });
});

describe('the Codex adapter catalog', () => {
  it('serves its fallback list until the server starts the read, then the CLI list', async () => {
    let reads = 0;
    const codex = createCodexEngine({
      installer: createFakeEngine().installer,
      readModels: async () => {
        reads += 1;
        return LIVE;
      },
    });

    expect(codex.modelCatalog()).toBe(CODEX_FALLBACK_CATALOG);
    await codex.startModelCatalog();
    expect(reads).toBe(1);
    expect(codex.modelCatalog()).toBe(LIVE);
  });

  it('does not read the models of a Codex that is not installed', async () => {
    const installer = createFakeEngine().installer;
    installer.getStatus = () => ({ installed: false, version: null, command: null });
    let reads = 0;
    const codex = createCodexEngine({ installer, readModels: async () => { reads += 1; return LIVE; } });

    await codex.startModelCatalog();
    expect(reads).toBe(0);
    expect(codex.modelCatalog()).toBe(CODEX_FALLBACK_CATALOG);
  });
});

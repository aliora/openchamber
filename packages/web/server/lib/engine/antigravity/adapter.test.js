import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAntigravityEngine, getAgyAuthStatus, parseModelListing, readAgyModels } from './adapter.js';
import { AgyProcess } from './agy-process.js';
import { AntigravityInstaller } from './installer.js';
import { createEngineRegistry } from '../registry.js';
import { createClaudeEngine } from '../claude/adapter.js';
import { EngineSessionRuntime } from '../session-runtime.js';
import { LocalSessionStore } from '../store.js';
import { ControlBridge } from '../control-bridge.js';
import { StreamHub } from '../stream-hub.js';

const MODEL_LISTING = 'Available models:\n'
  + 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
  + 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'
  + 'claude-sonnet-5-5\tClaude Sonnet 5.5 (Thinking)\n';

const notInstalled = new AntigravityInstaller({ detect: () => ({ installed: false, version: null, command: null }) });

describe('createAntigravityEngine', () => {
  it('registers after Claude without becoming the default', () => {
    const registry = createEngineRegistry([
      createClaudeEngine({ installer: notInstalled, authStatusProvider: async () => ({ loggedIn: false }) }),
      createAntigravityEngine({ installer: notInstalled }),
    ]);
    expect(registry.getDefault().id).toBe('claude');
    expect(registry.get('antigravity')).toMatchObject({
      displayName: 'Antigravity',
      providerID: 'google',
      defaultPermissionMode: 'dangerously-skip-permissions',
      dangerousPermissionModes: ['dangerously-skip-permissions'],
    });
    expect(registry.get('antigravity').modelCatalog().defaultModel).toBe('default');
  });

  it('offers auto mode only once agy showed that the signed-in account has it', async () => {
    const withoutAuto = ['default', 'accept-edits', 'dangerously-skip-permissions'];
    const signedIn = async () => ({ loggedIn: true });
    const probes = [];
    const probeAutoMode = async () => {
      probes.push('probe');
      return true;
    };

    const linux = createAntigravityEngine({ installer: notInstalled, platform: 'linux', authStatusProvider: signedIn, probeAutoMode });
    expect(linux.permissionModes).toEqual(withoutAuto);
    await linux.startPermissionModeProbe();
    await linux.startPermissionModeProbe();
    expect(linux.permissionModes).toEqual(['default', 'accept-edits', 'auto', 'dangerously-skip-permissions']);
    expect(probes).toHaveLength(1);

    const noAuto = createAntigravityEngine({ installer: notInstalled, platform: 'linux', authStatusProvider: signedIn, probeAutoMode: async () => false });
    await noAuto.startPermissionModeProbe();
    expect(noAuto.permissionModes).toEqual(withoutAuto);

    const failed = createAntigravityEngine({
      installer: notInstalled,
      platform: 'linux',
      authStatusProvider: signedIn,
      probeAutoMode: async () => {
        throw new Error('spawn failed');
      },
    });
    await failed.startPermissionModeProbe();
    expect(failed.permissionModes).toEqual(withoutAuto);

    const signedOut = createAntigravityEngine({ installer: notInstalled, platform: 'linux', authStatusProvider: async () => ({ loggedIn: false }), probeAutoMode });
    await signedOut.startPermissionModeProbe();
    const windows = createAntigravityEngine({ installer: notInstalled, platform: 'win32', authStatusProvider: signedIn, probeAutoMode });
    await windows.startPermissionModeProbe();
    expect(windows.permissionModes).toEqual(withoutAuto);
    expect(signedOut.permissionModes).toEqual(withoutAuto);
    expect(probes).toHaveLength(1);
  });

  it('answers sign-in and sign-out with the step to take in agy', () => {
    const { auth } = createAntigravityEngine({ installer: notInstalled });
    expect(() => auth.login()).toThrow('run `agy` in a terminal');
    expect(() => auth.logout()).toThrow('/logout');
  });

  it('creates a process that has not started agy yet', () => {
    const proc = createAntigravityEngine({ installer: notInstalled }).createProcess({ cwd: '/work', model: 'default', permissionMode: 'default' });
    expect(proc).toBeInstanceOf(AgyProcess);
    expect(proc.isAlive).toBe(false);
  });
});

describe('Antigravity sign-in check', () => {
  it('reads the models agy lists', () => {
    expect(parseModelListing(MODEL_LISTING)).toEqual([
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Thinking)' },
    ]);
    expect(parseModelListing('Available models:\n\n')).toEqual([]);
  });

  it('counts an account as signed in when agy lists models for it', async () => {
    const run = (stdout, exitCode = 0, error = null) => async () => ({ exitCode, stdout, error });
    expect(await getAgyAuthStatus({ run: run(MODEL_LISTING) })).toEqual({ loggedIn: true, email: null });
    expect(await getAgyAuthStatus({ run: run('Available models:\n') }))
      .toEqual({ loggedIn: false, email: null, reason: 'not_signed_in' });
    expect(await getAgyAuthStatus({ run: run('', 1) }))
      .toEqual({ loggedIn: false, email: null, reason: 'agy models exited with code 1' });
    expect(await getAgyAuthStatus({ run: run('', null, new Error('spawn agy ENOENT')) }))
      .toEqual({ loggedIn: false, email: null, reason: 'agy_unavailable' });
  });
});

const LIVE_LISTING = ''
  + 'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n'
  + 'gemini-4-argon-high\tGemini 4 Argon (High)\n'
  + 'gemini-4-argon-low\tGemini 4 Argon (Low)\n'
  + 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
  + 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'
  + 'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n'
  + 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';

const runListing = (stdout, exitCode = 0, error = null) => async (args) => {
  expect(args).toEqual(['models']);
  return { exitCode, stdout, error };
};

describe('Antigravity model list', () => {
  it('groups the effort variants agy lists under one model each, after the CLI default', async () => {
    expect(await readAgyModels({ run: runListing(LIVE_LISTING) })).toEqual({
      models: [
        { id: 'default', name: 'Antigravity default', efforts: [] },
        { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'high'] },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['medium'] },
        { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', efforts: ['medium'] },
      ],
      defaultModel: 'default',
    });
  });

  it('keeps a model without an effort variant as agy names it', async () => {
    const catalog = await readAgyModels({ run: runListing(MODEL_LISTING) });
    expect(catalog.models.at(-1)).toEqual({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Thinking)', efforts: [] });
  });

  it('fails when agy lists nothing, exits with an error or does not start', async () => {
    await expect(readAgyModels({ run: runListing('Available models:\n') })).rejects.toThrow('no account is signed in');
    await expect(readAgyModels({ run: runListing('', 1) })).rejects.toThrow('agy models exited with code 1');
    await expect(readAgyModels({ run: runListing('', null, new Error('spawn agy ENOENT')) })).rejects.toThrow('spawn agy ENOENT');
  });

  it('serves its fallback list until the server starts the read, then what agy listed', async () => {
    const installed = new AntigravityInstaller({ detect: () => ({ installed: true, version: '1.4.2', command: '/usr/local/bin/agy' }) });
    const agy = createAntigravityEngine({ installer: installed, readModels: () => readAgyModels({ run: runListing(LIVE_LISTING) }) });

    expect(agy.modelCatalog().models.map((model) => model.id)).toEqual(['default', 'gemini-3.8-flash']);
    await agy.startModelCatalog();
    expect(agy.modelCatalog().models.map((model) => model.id))
      .toEqual(['default', 'gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'gpt-oss-120b']);
    expect(agy.modelCatalog().defaultModel).toBe('default');
  });
});

describe('Antigravity sessions in the engine runtime', () => {
  const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const CONVERSATION = '7d0f5b1e-3c2a-4e8b-9f61-2a4d8c0e5b93';

  let tmpDir;
  let store;
  let runtime;
  let children;
  let adapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-agy-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    runtime = new EngineSessionRuntime({ store, streamHub: new StreamHub(), controlBridge: new ControlBridge() });
    children = [];
    const spawnProcess = (args) => {
      const child = new EventEmitter();
      Object.assign(child, { args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
      child.kill = (signal) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      children.push(child);
      return child;
    };
    adapter = createAntigravityEngine({
      installer: notInstalled,
      createAgyProcess: (options) => new AgyProcess({ ...options, spawnProcess }),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores the answer and resumes the agy conversation in the next process', async () => {
    const session = await store.createSession({ engine: 'antigravity', cwd: '/work/app', model: 'default', permissionMode: 'default' });
    const options = { session, adapter, model: 'default', effort: 'medium', permissionMode: 'default' };

    const { assistantMessageID } = await runtime.prompt({ ...options, text: 'run the tests' });
    children[0].stdout.write(fixture('turn-with-tool.ndjson'));
    await flush();
    await flush();

    const stored = await store.getMessages(session.id);
    expect(stored.find((m) => m.id === assistantMessageID).content).toBe("I'll run the tests first.\nAll 12 tests pass.\n");
    expect((await store.getSession(session.id)).engineState).toEqual({ conversationId: CONVERSATION });

    await runtime.abort(session.id);
    await runtime.prompt({ ...options, text: 'does it cover the parser?' });
    expect(children).toHaveLength(2);
    expect(children[1].args).toEqual(expect.arrayContaining(['--conversation', CONVERSATION]));
  });
});

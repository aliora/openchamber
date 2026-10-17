import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAntigravityEngine, getAgyAuthStatus, parseModelListing } from './adapter.js';
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
      defaultPermissionMode: 'default',
    });
    expect(registry.get('antigravity').modelCatalog().defaultModel).toBe('default');
  });

  it('offers auto mode only where agy has it', () => {
    expect(createAntigravityEngine({ installer: notInstalled, platform: 'linux' }).permissionModes)
      .toEqual(['default', 'accept-edits', 'auto', 'dangerously-skip-permissions']);
    expect(createAntigravityEngine({ installer: notInstalled, platform: 'win32' }).permissionModes)
      .toEqual(['default', 'accept-edits', 'dangerously-skip-permissions']);
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

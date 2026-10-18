import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { createFakeEngine } from '../test/fake-engine.js';
import { createClaudeEngine } from './adapter.js';
import { CLAUDE_FALLBACK_CATALOG, CLAUDE_MODEL_LIST_ARGS, readClaudeModels } from './model-catalog.js';

const LISTED = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 42 },
];

const initializeResponse = (requestId, models) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { commands: [], models } },
});

const createFakeClaudeChild = ({ answer = (request) => [initializeResponse(request.request_id, LISTED)] } = {}) => {
  const child = new EventEmitter();
  const sent = [];
  Object.assign(child, {
    sent,
    killed: false,
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, encoding, callback) {
        const request = JSON.parse(chunk.toString());
        sent.push(request);
        child.stdout.write('{"type":"system","subtype":"ui_invalidate"}\nnot json\n');
        for (const line of answer(request)) child.stdout.write(`${JSON.stringify(line)}\n`);
        callback();
      },
    }),
    kill(signal) {
      child.killed = true;
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', null, signal);
      });
      return true;
    },
  });
  return child;
};

const readFrom = (child, options = {}) => {
  const spawns = [];
  const result = readClaudeModels({
    spawnProcess: (args, spawnOptions) => {
      spawns.push({ args, options: spawnOptions });
      return child;
    },
    ...options,
  });
  return { result, spawns };
};

describe('readClaudeModels', () => {
  it('reads the models from the initialize answer without a turn, and stops the CLI', async () => {
    const child = createFakeClaudeChild();
    const { result, spawns } = readFrom(child);
    const catalog = await result;

    expect(spawns).toEqual([{ args: CLAUDE_MODEL_LIST_ARGS, options: { cwd: os.homedir() } }]);
    expect(CLAUDE_MODEL_LIST_ARGS).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--settings', '{"disableAllHooks":true}']));
    expect(child.sent).toHaveLength(1);
    expect(child.sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(child.killed).toBe(true);

    expect(catalog).toEqual({
      models: [
        { id: 'opus', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
        { id: 'haiku', name: 'Claude Haiku', family: 'claude-haiku' },
      ],
      defaultModel: 'sonnet',
    });
  });

  it('ignores an answer to another request and fails when the CLI lists no model', async () => {
    const child = createFakeClaudeChild({
      answer: (request) => [initializeResponse('other', LISTED), initializeResponse(request.request_id, [{ value: 'default' }])],
    });
    await expect(readFrom(child).result).rejects.toThrow('Claude Code listed no models');
  });

  it('fails when the CLI exits first, does not answer in time or cannot start', async () => {
    const exits = createFakeClaudeChild({ answer: () => [] });
    const exited = readFrom(exits).result;
    exits.emit('exit', 1, null);
    await expect(exited).rejects.toThrow('Claude Code exited before listing its models (1)');

    const silent = createFakeClaudeChild({ answer: () => [] });
    await expect(readFrom(silent, { timeoutMs: 20 }).result).rejects.toThrow('did not list its models');
    expect(silent.killed).toBe(true);

    const missing = createFakeClaudeChild({ answer: () => [] });
    const failed = readFrom(missing).result;
    missing.emit('error', new Error('spawn claude ENOENT'));
    await expect(failed).rejects.toThrow('spawn claude ENOENT');
  });
});

describe('the Claude adapter catalog', () => {
  it('serves the aliases until the server starts the read, then the CLI list', async () => {
    const claude = createClaudeEngine({
      installer: createFakeEngine().installer,
      readModels: () => readFrom(createFakeClaudeChild()).result,
    });

    expect(claude.modelCatalog()).toBe(CLAUDE_FALLBACK_CATALOG);
    await claude.startModelCatalog();
    expect(claude.modelCatalog().models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'claude-haiku-4-5-20251001', 'haiku']);
    expect(claude.modelCatalog().defaultModel).toBe('sonnet');
  });
});

import { afterAll, describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AgyProcess, buildAgyCliArgs } from './agy-process.js';

// The fixtures follow the stream-json events agy 1.1.22 to 1.3.x printed in public
// captures (listed in ../DOCUMENTATION.md), with values of their own.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8').split('\n').filter(Boolean);

const CONVERSATION = '7d0f5b1e-3c2a-4e8b-9f61-2a4d8c0e5b93';

const createFakeChild = () => {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    prompts: [],
    signals: [],
  });
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) child.prompts.push(JSON.parse(line));
  });
  child.exit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => child.exit(null, signal));
    return true;
  };
  return child;
};

const ENGINE_EVENTS = ['text.delta', 'reasoning.delta', 'tool.started', 'tool.called', 'tool.completed', 'permission.requested', 'turn.completed', 'engine.state', 'exit', 'error'];

const startProcess = async (options = {}) => {
  const child = createFakeChild();
  const spawned = [];
  const proc = new AgyProcess({
    cwd: '/work/app',
    model: 'default',
    permissionMode: 'default',
    ...options,
    spawnProcess: (args, spawnOptions) => {
      spawned.push({ args, ...spawnOptions });
      return child;
    },
  });
  const events = [];
  for (const name of ENGINE_EVENTS) proc.on(name, (payload) => events.push([name, payload]));
  await proc.start();
  return { proc, child, events, spawned };
};

// readline and the stdin reader both deliver on later ticks.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const feed = async (stream, lines) => {
  for (const line of lines) stream.write(`${line}\n`);
  await flush();
  await flush();
};

const named = (events, name) => events.filter(([eventName]) => eventName === name).map(([, payload]) => payload);

describe('buildAgyCliArgs', () => {
  it('starts a multi-turn stream-json session with the CLI defaults', () => {
    expect(buildAgyCliArgs({ model: 'default', effort: 'medium', permissionMode: 'default' }))
      .toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json']);
  });

  it('passes an explicit model with its effort, the mode flag and the conversation to resume', () => {
    const args = buildAgyCliArgs({
      model: 'gemini-3.8-flash',
      effort: 'high',
      permissionMode: 'accept-edits',
      conversationId: CONVERSATION,
    });
    expect(args).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--mode', 'accept-edits',
      '--conversation', CONVERSATION,
      '--model', 'gemini-3.8-flash', '--effort', 'high',
    ]);
  });

  it('maps every permission mode to its flag and rejects any other', () => {
    expect(buildAgyCliArgs({ permissionMode: 'auto' })).toContain('auto');
    expect(buildAgyCliArgs({ permissionMode: 'dangerously-skip-permissions' })).toContain('--dangerously-skip-permissions');
    expect(() => buildAgyCliArgs({ permissionMode: 'plan' })).toThrow('Unknown Antigravity permission mode: plan');
  });

  it('keeps each flag and its value as separate arguments and never passes the prompt as one', () => {
    const args = buildAgyCliArgs({ model: 'default', permissionMode: 'auto', addDir: '/tmp/openchamber-agy-x' });
    expect(args).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--mode', 'auto',
      '--add-dir', '/tmp/openchamber-agy-x',
    ]);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
  });
});

describe('AgyProcess', () => {
  it('streams a turn with a tool call and reports its usage without double counting', async () => {
    const { proc, child, events, spawned } = await startProcess();
    proc.sendUserMessage('run the tests');
    await flush();
    expect(child.prompts).toEqual([{ event: 'user', message: { content: 'run the tests' } }]);
    expect(spawned[0].cwd).toBe('/work/app');
    expect(spawned[0].args).not.toContain('--conversation');

    await feed(child.stdout, fixture('turn-with-tool.ndjson'));

    expect(named(events, 'engine.state')).toEqual([{ conversationId: CONVERSATION }]);
    expect(named(events, 'text.delta').map((d) => d.text).join('')).toBe("I'll run the tests first.\nAll 12 tests pass.\n");
    expect(named(events, 'tool.started')).toEqual([{ id: `${CONVERSATION}:3`, name: 'run_command', input: {} }]);
    expect(named(events, 'turn.completed')).toEqual([{
      outcome: 'succeeded',
      // Steps 2 and 4: cache reads come out of input, thinking out of output.
      // The context the turn ends with is step 4's: 10611 read and 64 written.
      usage: { input: 2560, output: 55, reasoning: 191, cacheRead: 18353, cacheWrite: 0, total: 10675 },
    }]);
    expect(named(events, 'permission.requested')).toEqual([]);
    expect(() => proc.respondPermission('req', 'allow')).toThrow('does not ask the host');
  });

  it('resumes the stored conversation and counts only the new turn', async () => {
    const { proc, child, events, spawned } = await startProcess({ engineState: { conversationId: CONVERSATION } });
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--conversation', CONVERSATION]));

    proc.sendUserMessage('does it cover the parser?');
    await feed(child.stdout, fixture('resumed-second-turn.ndjson'));

    expect(named(events, 'engine.state')).toEqual([]);
    // The result carries the conversation's running total; the turn is step 6 alone.
    expect(named(events, 'turn.completed')).toEqual([{
      outcome: 'succeeded',
      usage: { input: 240, output: 18, reasoning: 12, cacheRead: 10600, cacheWrite: 0, total: 10870 },
    }]);
  });

  it('adopts the new conversation when agy could not resume the stored one', async () => {
    const { proc, child, events } = await startProcess({ engineState: { conversationId: '0b8e2f1c-5d3a-4c7e-8a9b-1f2e3d4c5b6a' } });
    proc.sendUserMessage('hello');
    await feed(child.stdout, fixture('turn-with-tool.ndjson'));
    expect(named(events, 'engine.state')).toEqual([{ conversationId: CONVERSATION }]);
  });

  it('ignores stored state that is not a conversation id', async () => {
    for (const engineState of [null, { conversationId: '--dangerously-skip-permissions' }, { conversationId: 42 }]) {
      const { spawned } = await startProcess({ engineState });
      expect(spawned[0].args).not.toContain('--conversation');
    }
  });

  it('writes the next prompt only after agy finished the previous one', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('one');
    proc.sendUserMessage('two');
    await flush();
    expect(child.prompts.map((p) => p.message.content)).toEqual(['one']);

    await feed(child.stdout, fixture('turn-with-tool.ndjson'));
    expect(named(events, 'turn.completed')).toHaveLength(1);
    expect(child.prompts.map((p) => p.message.content)).toEqual(['one', 'two']);
  });

  it('fails a turn that agy ends with an error result', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('explain');
    await feed(child.stdout, fixture('model-error.ndjson'));
    expect(named(events, 'text.delta')).toEqual([{ text: 'Looking at the' }]);
    expect(named(events, 'turn.completed').map((t) => t.outcome)).toEqual(['failed']);
  });

  it('fails a turn that printed an AGY_ERROR line even when the result says success', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('explain');
    // Only the prefix is read; agy does not document the fields after it.
    await feed(child.stderr, ['AGY_ERROR: {"retryable":false}']);
    await feed(child.stdout, fixture('turn-with-tool.ndjson'));
    expect(named(events, 'turn.completed').map((t) => t.outcome)).toEqual(['failed']);

    proc.sendUserMessage('again');
    await feed(child.stdout, fixture('resumed-second-turn.ndjson'));
    expect(named(events, 'turn.completed').map((t) => t.outcome)).toEqual(['failed', 'succeeded']);
  });

  it('fails the running turn with its usage so far when agy exits', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('run the tests');
    proc.sendUserMessage('queued');
    await feed(child.stdout, fixture('turn-with-tool.ndjson').slice(0, 4));
    child.exit(3);

    expect(events.slice(-2)).toEqual([
      ['turn.completed', { outcome: 'failed', usage: { input: 2189, output: 31, reasoning: 151, cacheRead: 8113, cacheWrite: 0, total: 10484 } }],
      ['exit', { code: 3, signal: null }],
    ]);
    expect(proc.isAlive).toBe(false);
    expect(() => proc.sendUserMessage('after exit')).toThrow('not writable');
  });

  it('stops without ending a turn on abort', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('long task');
    await flush();
    await proc.abort();

    expect(child.signals).toEqual(['SIGINT']);
    expect(named(events, 'turn.completed')).toEqual([]);
    expect(named(events, 'exit')).toEqual([{ code: null, signal: 'SIGINT' }]);
    expect(proc.isAlive).toBe(false);
  });

  it('skips lines it does not understand', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('/usage');
    await feed(child.stdout, [
      'Warning: not JSON',
      '{"event":"command_result","command":{"name":"usage","data":{"groups":[]}}}',
      '{"event":"step_update"}',
      '{"event":"result","result":{"status":"SUCCESS","usage":"none"}}',
    ]);
    expect(events).toEqual([
      ['turn.completed', { outcome: 'succeeded', usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
    ]);
  });
});

describe('AgyProcess permission refusals', () => {
  it('fails an answerless turn whose tool call headless agy refused and names the fix', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('run echo hello-agy');
    await feed(child.stderr, ['jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.']);
    await feed(child.stdout, fixture('permission-denied.ndjson'));

    const [completed] = named(events, 'turn.completed');
    expect(completed.outcome).toBe('failed');
    expect(completed.error.type).toBe('PermissionDenied');
    expect(completed.error.message).toContain('"command" permission');
    expect(completed.error.message).toContain('"dangerously-skip-permissions"');
    expect(completed.error.message).toContain('command(<target>) under permissions.allow');
  });

  it('fails the turn agy 1.4.1 ends after refusing a command, even with no stderr hint', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('run ls /definitely-missing-dir');
    await feed(child.stdout, fixture('permission-denied-1.4.1.ndjson'));

    const completed = named(events, 'turn.completed');
    expect(completed.map((turn) => turn.outcome)).toEqual(['failed']);
    expect(completed[0].error.type).toBe('PermissionDenied');
    expect(completed[0].error.message).toContain('"command" permission');
  });

  it('names the refusal from the tool step when the result lists no denied actions', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('run ls');
    const lines = fixture('permission-denied-1.4.1.ndjson').map((line) => line.replace(/,"denied_actions":\[[^\]]*\]/, ''));
    await feed(child.stdout, lines);

    const [completed] = named(events, 'turn.completed');
    expect(completed.error.type).toBe('PermissionDenied');
    expect(completed.error.message).toContain('"command" permission');
  });

  it('fails a turn that ends with no text and no tool call instead of ending silently', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('hello');
    await feed(child.stdout, ['{"event":"result","result":{"status":"SUCCESS","response":""}}']);

    const [completed] = named(events, 'turn.completed');
    expect([completed.outcome, completed.error.type]).toEqual(['failed', 'EmptyResponse']);
  });

  it('keeps a turn that answered in text as succeeded even when a call was refused', async () => {
    const { proc, child, events } = await startProcess();
    proc.sendUserMessage('run echo hello-agy');
    await feed(child.stdout, [
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"I could not run it."}}',
      '{"event":"result","result":{"status":"SUCCESS","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
    ]);
    expect(named(events, 'turn.completed').map((t) => [t.outcome, t.error])).toEqual([['succeeded', undefined]]);
  });
});

describe('AgyProcess tool server', () => {
  const TOOL_SERVER = { name: 'openchamber', url: 'http://127.0.0.1:4100/mcp', token: 'secret-token' };
  const pluginFile = (root, ...parts) => path.join(root, '.agents', 'plugins', 'openchamber', ...parts);
  const pluginParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tool-test-'));
  afterAll(() => fs.rmSync(pluginParent, { recursive: true, force: true }));

  const startWithTools = (options = {}) => startProcess({
    toolServer: TOOL_SERVER,
    toolInstructions: 'Prefer openchamber_web for the browser panel.',
    toolPluginDirectory: pluginParent,
    ...options,
  });

  it('hands agy the tool server and its instructions as a plugin in an added directory', async () => {
    const { proc, spawned } = await startWithTools();
    const { args, env } = spawned[0];
    const root = args[args.indexOf('--add-dir') + 1];

    expect(JSON.parse(fs.readFileSync(pluginFile(root, 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: { openchamber: { url: TOOL_SERVER.url, headers: { Authorization: 'Bearer secret-token' } } },
    });
    expect(fs.readFileSync(pluginFile(root, 'rules', 'AGENTS.md'), 'utf8')).toBe('Prefer openchamber_web for the browser panel.\n');
    expect(fs.statSync(pluginFile(root, 'mcp_config.json')).mode & 0o777).toBe(0o600);
    expect(args.join(' ')).not.toContain('secret-token');
    expect(env.NO_PROXY.split(',')).toContain('127.0.0.1');

    await proc.abort();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('reports its own MCP calls by the tool name with their result', async () => {
    const { proc, child, events } = await startWithTools();
    proc.sendUserMessage('show the status page');
    await feed(child.stdout, fixture('mcp-tool-call.ndjson'));

    const id = 'a193ca01-374c-4107-afb2-1a51d0f52caa:4';
    const input = { action: 'render.page', parameters: { title: 'Status' } };
    expect(named(events, 'tool.started').at(-1)).toEqual({ id, name: 'openchamber_render', input });
    expect(named(events, 'tool.called')).toEqual([{ id, name: 'openchamber_render', input }]);
    expect(named(events, 'tool.completed')).toEqual([{ id, output: '{"ok":true,"action":"render.page"}', isError: false }]);
    expect(named(events, 'turn.completed').map((t) => t.outcome)).toEqual(['succeeded']);
  });

  it('names another MCP server\'s calls by server and tool and removes the plugin when agy exits', async () => {
    const { proc, child, events, spawned } = await startWithTools();
    const root = spawned[0].args[spawned[0].args.indexOf('--add-dir') + 1];
    proc.sendUserMessage('query');
    await feed(child.stdout, [
      '{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"q":1},"ServerName":"sqlite","ToolName":"query"},"error":{"message":"denied"}}}}',
    ]);
    expect(named(events, 'tool.started')).toEqual([{ id: 'agy:2', name: 'mcp__sqlite__query', input: { q: 1 } }]);
    expect(named(events, 'tool.completed')).toEqual([]);

    child.exit(0);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('passes no added directory and the plain environment without a tool server', async () => {
    const { spawned } = await startProcess();
    expect(spawned[0].args).not.toContain('--add-dir');
    expect(spawned[0].env).toBeUndefined();
  });
});

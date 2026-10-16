import { describe, it, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ClaudeProcess, buildClaudeCliArgs } from './claude-process.js';
import { createClaudeEngine } from './adapter.js';

describe('buildClaudeCliArgs', () => {
  it('constructs mandatory flags for headless stream-json execution', () => {
    const args = buildClaudeCliArgs({
      sessionId: 'test-session-123',
      model: 'sonnet',
      effort: 'medium',
      permissionMode: 'auto',
      resume: true,
    });

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args.join(' ')).toContain('--permission-prompt-tool stdio');
    expect(args).not.toContain('--permission-prompts');
    expect(args.join(' ')).toContain('--resume test-session-123');
    expect(args).not.toContain('--session-id');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--effort');
    expect(args).toContain('medium');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('auto');
  });

  it('starts a new transcript under the session id until there is one to resume', () => {
    const args = buildClaudeCliArgs({ sessionId: 'fresh-session', resume: false });
    expect(args.join(' ')).toContain('--session-id fresh-session');
    expect(args).not.toContain('--resume');
  });

  it('handles plan permission mode properly', () => {
    const args = buildClaudeCliArgs({
      sessionId: 'plan-session',
      permissionMode: 'plan',
    });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
  });
});

describe('ClaudeProcess stream line parsing', () => {
  it('parses system init events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('init', (payload) => {
      expect(payload.session_id).toBe('c1be619a');
      expect(payload.model).toBe('claude-sonnet-5-5');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'c1be619a',
      model: 'claude-sonnet-5-5',
      tools: ['Read', 'Write'],
    }));
  });

  it('parses thinking_delta events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('thinking_delta', (payload) => {
      expect(payload.text).toBe('Thinking about architecture...');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Thinking about architecture...',
        },
      },
    }));
  });

  it('parses text_delta events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('text_delta', (payload) => {
      expect(payload.text).toBe('Hello world!');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: 'Hello world!',
        },
      },
    }));
  });

  it('parses control_request events for interactive approval', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('control_request', (payload) => {
      expect(payload.requestId).toBe('req-123');
      expect(payload.toolName).toBe('Bash');
      expect(payload.command).toBe('npm test');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'control_request',
      request_id: 'req-123',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
      },
    }));
  });

  it('parses result events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('result', (payload) => {
      expect(payload.result).toBe('Done.');
      expect(payload.durationMs).toBe(1234);
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      duration_ms: 1234,
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  });
});

const TOOL_SERVER = { name: 'openchamber', url: 'http://127.0.0.1:3901/api/openchamber/mcp', token: 'tok_secret_value_1234567890' };

// A child process stand-in: the streams ClaudeProcess wires, and what it was spawned with.
const createFakeSpawn = () => {
  const spawned = [];
  const spawn = (args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null });
    spawned.push({ args, options, child });
    return child;
  };
  return { spawn, spawned };
};

const tempDirectories = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const makeTempDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claude-mcp-test-'));
  tempDirectories.push(directory);
  return directory;
};

describe('Claude CLI args for the tool server', () => {
  it('names the config file and pre-allows only the tool server\'s tools', () => {
    const args = buildClaudeCliArgs({ sessionId: 's1', toolServer: TOOL_SERVER, mcpConfigPath: '/tmp/x/mcp.json' });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x/mcp.json');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__openchamber__*');
    // The user's own MCP servers keep loading.
    expect(args).not.toContain('--strict-mcp-config');
    expect(args.join(' ')).not.toContain(TOOL_SERVER.token);
  });

  it('adds no MCP flags without a tool server', () => {
    const args = buildClaudeCliArgs({ sessionId: 's1' });
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
  });

  it('asks Claude to echo each prompt when it takes it', () => {
    expect(buildClaudeCliArgs({ sessionId: 's1' })).toContain('--replay-user-messages');
  });
});

describe('ClaudeProcess with a tool server', () => {
  it('writes a private config file, keeps the token out of argv and removes the file on exit', async () => {
    const { spawn, spawned } = createFakeSpawn();
    const proc = new ClaudeProcess({ sessionId: 's1', cwd: process.cwd(), toolServer: TOOL_SERVER, spawn, mcpConfigDirectory: makeTempDirectory() });
    await proc.start();

    const [{ args, options, child }] = spawned;
    const configPath = args[args.indexOf('--mcp-config') + 1];
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: { openchamber: { type: 'http', url: TOOL_SERVER.url, headers: { Authorization: `Bearer ${TOOL_SERVER.token}` } } },
    });
    expect(args.join(' ')).not.toContain(TOOL_SERVER.token);
    expect(Object.values(options.env).join(' ')).not.toContain(TOOL_SERVER.token);
    expect(options.env.NO_PROXY.split(',')).toContain('127.0.0.1');
    // Binary lookup reads HOME and PATH from the same environment.
    expect(options.env.PATH).toBe(process.env.PATH);

    child.emit('exit', 0, null);
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);
  });

  it('removes the config when the CLI cannot be spawned', async () => {
    const { spawn, spawned } = createFakeSpawn();
    const proc = new ClaudeProcess({ sessionId: 's1', cwd: process.cwd(), toolServer: TOOL_SERVER, spawn, mcpConfigDirectory: makeTempDirectory() });
    const errors = [];
    proc.on('error', (error) => errors.push(error));
    await proc.start();
    const configPath = spawned[0].args[spawned[0].args.indexOf('--mcp-config') + 1];

    spawned[0].child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(errors.map((error) => error.code)).toEqual(['ENOENT']);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('writes no config without a tool server', async () => {
    const { spawn, spawned } = createFakeSpawn();
    const directory = makeTempDirectory();
    const proc = new ClaudeProcess({ sessionId: 's1', cwd: process.cwd(), spawn, mcpConfigDirectory: directory });
    await proc.start();
    expect(spawned[0].args).not.toContain('--mcp-config');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('reports a write to a CLI that already exited as a process error instead of crashing', async () => {
    const { spawn, spawned } = createFakeSpawn();
    const proc = new ClaudeProcess({ sessionId: 's1', cwd: process.cwd(), spawn });
    const errors = [];
    proc.on('error', (error) => errors.push(error));
    await proc.start();

    spawned[0].child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.map((error) => error.code)).toEqual(['EPIPE']);
  });
});

describe('ClaudeProcess tool calls in the stream', () => {
  const collect = (proc, names) => {
    const seen = [];
    for (const name of names) proc.on(name, (payload) => seen.push([name, payload]));
    return seen;
  };

  it('reports a call once its input is final, and its result as text', () => {
    const proc = new ClaudeProcess({ sessionId: 'dummy' });
    const seen = collect(proc, ['tool_use', 'tool_result', 'prompt_consumed']);
    proc.handleOutputLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__openchamber__openchamber_render', input: { action: 'render.page' } }] } }));
    proc.handleOutputLine(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'line 1' }, { type: 'image' }, { type: 'text', text: 'line 2' }] }] } }));
    proc.handleOutputLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'denied', is_error: true }] } }));

    expect(seen).toEqual([
      ['tool_use', { id: 'toolu_1', name: 'mcp__openchamber__openchamber_render', input: { action: 'render.page' } }],
      ['tool_result', { id: 'toolu_1', output: 'line 1\nline 2', isError: false }],
      ['tool_result', { id: 'toolu_2', output: 'denied', isError: true }],
    ]);
  });

  it('leaves a subagent\'s own calls out and reports an echoed prompt', () => {
    const proc = new ClaudeProcess({ sessionId: 'dummy' });
    const seen = collect(proc, ['tool_use', 'tool_result', 'prompt_consumed']);
    proc.handleOutputLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: {} }] } }));
    proc.handleOutputLine(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
    expect(seen).toEqual([['prompt_consumed', undefined]]);
  });
});

describe('Claude engine process', () => {
  const createEngineProcess = (options = {}) => {
    const { spawn, spawned } = createFakeSpawn();
    const engine = createClaudeEngine({ installer: { getStatus: () => ({}) } });
    const proc = engine.createProcess({ sessionId: 's1', cwd: process.cwd(), spawn, mcpConfigDirectory: makeTempDirectory(), ...options });
    const emitLine = (value) => spawned[0].child.stdout.write(`${JSON.stringify(value)}\n`);
    return { proc, emitLine, spawned };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('reports the tool server\'s tools by their own names and leaves other tools alone', async () => {
    const { proc, emitLine } = createEngineProcess({ toolServer: TOOL_SERVER });
    const seen = [];
    for (const name of ['tool.started', 'tool.called', 'tool.completed']) proc.on(name, (payload) => seen.push([name, payload]));
    await proc.start();
    emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__openchamber__openchamber_web', input: {} } } });
    emitLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__openchamber__openchamber_web', input: { action: 'browser.open' } }] } });
    emitLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }] } });
    emitLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__github__search', input: {} }] } });
    await settle();

    expect(seen).toEqual([
      ['tool.started', { id: 'toolu_1', name: 'openchamber_web', input: {} }],
      ['tool.called', { id: 'toolu_1', name: 'openchamber_web', input: { action: 'browser.open' } }],
      ['tool.completed', { id: 'toolu_1', output: '{}', isError: false }],
      ['tool.called', { id: 'toolu_2', name: 'mcp__github__search', input: {} }],
    ]);
  });

  it('starts a transcript once, records it, and resumes it in the next process', async () => {
    const first = createEngineProcess();
    const states = [];
    first.proc.on('engine.state', (state) => states.push(state));
    await first.proc.start();
    expect(first.spawned[0].args.join(' ')).toContain('--session-id s1');
    first.emitLine({ type: 'system', subtype: 'init', session_id: 's1' });
    first.emitLine({ type: 'system', subtype: 'init', session_id: 's1' });
    await settle();
    expect(states).toEqual([{ transcript: true }]);

    const next = createEngineProcess({ engineState: { transcript: true } });
    await next.proc.start();
    expect(next.spawned[0].args.join(' ')).toContain('--resume s1');
  });

  it('answers a denied permission prompt with a reason the agent can read', async () => {
    const { proc, spawned } = createEngineProcess();
    await proc.start();
    const written = [];
    spawned[0].child.stdin.on('data', (chunk) => written.push(JSON.parse(String(chunk))));
    proc.respondPermission('req-1', 'deny');
    proc.respondPermission('req-2', 'allow');
    await settle();
    expect(written.map((line) => line.response.response)).toEqual([
      { behavior: 'deny', message: 'The user denied this action.' },
      { behavior: 'allow' },
    ]);
  });

  it('reports a prompt Claude took into a running turn as merged', async () => {
    const { proc, emitLine } = createEngineProcess();
    const seen = [];
    for (const name of ['prompt.merged', 'turn.completed']) proc.on(name, () => seen.push(name));
    await proc.start();
    const replay = { type: 'user', isReplay: true, message: { content: [{ type: 'text', text: 'x' }] } };
    emitLine(replay);
    emitLine(replay);
    emitLine({ type: 'result', subtype: 'success', usage: {} });
    emitLine(replay);
    emitLine({ type: 'result', subtype: 'success', usage: {} });
    await settle();

    expect(seen).toEqual(['prompt.merged', 'turn.completed', 'turn.completed']);
  });
});

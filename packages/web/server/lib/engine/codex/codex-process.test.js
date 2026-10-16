import { describe, expect, it } from 'bun:test';
import { CodexProcess } from './codex-process.js';
import { createFakeCodexChild, readCodexTranscript } from '../test/fake-codex.js';

const THREAD_ID = '01a14700-0000-7000-8000-000000000001';
const ENGINE_EVENTS = ['reasoning.delta', 'text.delta', 'tool.started', 'permission.requested', 'turn.completed', 'engine.state'];

/** A CodexProcess on a fake app-server playing `transcript`, recording every engine event. */
const startOn = (transcript, options = {}) => {
  const spawns = [];
  const child = createFakeCodexChild(transcript);
  const proc = new CodexProcess({
    cwd: '/work/app',
    model: 'gpt-6.1-sol',
    effort: 'high',
    permissionMode: 'on-request',
    clientVersion: '1.0.0',
    spawnProcess: (args, spawnOptions) => {
      spawns.push({ args, options: spawnOptions });
      return child;
    },
    ...options,
  });
  const events = [];
  for (const name of ENGINE_EVENTS) proc.on(name, (payload) => events.push([name, payload]));
  proc.on('error', (error) => events.push(['error', error.message]));
  proc.on('exit', (info) => events.push(['exit', info]));
  return { proc, child, spawns, events };
};

const turnCompleted = (proc) => new Promise((resolve) => proc.once('turn.completed', resolve));
const sentMethods = (child) => child.sent.map((message) => message.method || `response:${message.id}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const named = (events, name) => events.filter(([eventName]) => eventName === name);

describe('CodexProcess', () => {
  it('drives a new thread through a turn with tools and approvals', async () => {
    const { proc, child, spawns, events } = startOn(readCodexTranscript('turn-with-tools'));
    // The user allows the command and declines the edit, after the prompt was shown.
    const decisions = ['allow', 'deny'];
    proc.on('permission.requested', (request) => {
      const decision = decisions.shift();
      setImmediate(() => proc.respondPermission(request.requestId, decision));
    });

    await proc.start();
    expect(spawns).toEqual([{ args: ['app-server'], options: { cwd: '/work/app' } }]);
    const done = turnCompleted(proc);
    proc.sendUserMessage('The add helper returns the wrong sum. Fix it.');
    await done;

    expect(child.finished).toBe(true);
    expect(sentMethods(child)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start', 'response:0', 'response:1']);
    expect(child.sent.every((message) => !('jsonrpc' in message))).toBe(true);
    const [initialize, , threadStart, turnStart, commandReply, fileReply] = child.sent;
    expect(initialize.params).toEqual({
      clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '1.0.0' },
      capabilities: null,
    });
    expect(threadStart.params).toEqual({
      cwd: '/work/app',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(turnStart.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'The add helper returns the wrong sum. Fix it.', text_elements: [] }],
      effort: 'high',
    });
    expect(commandReply).toEqual({ id: 0, result: { decision: 'accept' } });
    expect(fileReply).toEqual({ id: 1, result: { decision: 'decline' } });

    const permissions = named(events, 'permission.requested').map(([, request]) => request);
    expect(new Set(permissions.map((request) => request.requestId)).size).toBe(2);
    expect(permissions.map(({ requestId: _requestId, ...request }) => request)).toEqual([
      {
        toolName: 'shell',
        input: { command: "/bin/bash -lc 'npm test'", cwd: '/work/app', reason: 'Run the test suite to find the failing case?' },
        summary: 'Run the test suite to find the failing case?',
      },
      {
        toolName: 'edit',
        input: {
          path: '/work/app/src/math.js',
          changes: [{
            path: '/work/app/src/math.js',
            kind: 'update',
            diff: '@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n',
          }],
          reason: null,
        },
        summary: 'Codex wants to change /work/app/src/math.js',
      },
    ]);

    // The thread is stored once Codex accepted its first turn.
    expect(named(events, 'engine.state')).toEqual([['engine.state', { threadId: THREAD_ID }]]);
    expect(events.filter(([name]) => name !== 'permission.requested' && name !== 'engine.state')).toEqual([
      ['reasoning.delta', { text: '**Running the tests**' }],
      ['reasoning.delta', { text: '\n\nThe suite should show which case fails.' }],
      ['reasoning.delta', { text: '\n\n' }],
      ['reasoning.delta', { text: '**Checking the helper**' }],
      ['text.delta', { text: "I'll run the tests first." }],
      ['tool.started', { id: 'call_run_tests', name: 'shell', input: { command: "/bin/bash -lc 'npm test'", cwd: '/work/app' } }],
      ['tool.started', { id: 'call_fix_add', name: 'edit', input: { changes: [{ path: '/work/app/src/math.js', kind: 'update' }] } }],
      ['tool.started', { id: 'call_docs_search', name: 'mcp__docs__search', input: { query: 'add helper contract' } }],
      ['text.delta', { text: '\n\n' }],
      ['text.delta', { text: 'The fix is to return `a + b` in src/math.js.' }],
      ['text.delta', { text: ' I left the file unchanged because the edit was declined.' }],
      // The total grew from 0 to 39000 input (23500 cached) and 530 output (250 reasoning).
      ['turn.completed', { outcome: 'succeeded', usage: { input: 15500, output: 280, reasoning: 250, cacheRead: 23500, cacheWrite: 0 } }],
    ]);
  });

  it('ends a failed turn as failed', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('turn-failed'));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('say hi');

    expect(await done).toEqual({ outcome: 'failed', usage: null });
    await flush();
    expect(child.finished).toBe(true);
    // Codex wrote the failed turn to the thread, so the thread can still be resumed.
    expect(events.map(([name]) => name).sort()).toEqual(['engine.state', 'turn.completed']);
  });

  it('resumes the stored thread and counts only the usage of this turn', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('resume-turn'), {
      permissionMode: 'never',
      effort: 'medium',
      engineState: { threadId: THREAD_ID },
    });
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('Apply it now.');

    expect(await done).toEqual({
      outcome: 'succeeded',
      usage: { input: 1000, output: 40, reasoning: 0, cacheRead: 14000, cacheWrite: 0 },
    });
    const resume = child.sent.find((message) => message.method === 'thread/resume');
    expect(resume.params).toEqual({
      cwd: '/work/app',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      threadId: THREAD_ID,
      excludeTurns: true,
    });
    // The session already points at this thread, so there is nothing new to store.
    expect(events.some(([name]) => name === 'engine.state')).toBe(false);
  });

  it('starts a new thread when Codex no longer has the stored one', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('resume-missing-thread'), {
      engineState: { threadId: THREAD_ID },
    });
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('hello');
    await done;
    await flush();

    expect(sentMethods(child)).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/start', 'turn/start']);
    expect(named(events, 'engine.state')).toEqual([
      ['engine.state', { threadId: '01a14700-0000-7000-8000-000000000003' }],
    ]);
  });

  it('fails to start when resuming fails for another reason', async () => {
    const { proc } = startOn([
      { await: 'initialize' },
      { id: 1, result: { userAgent: 'openchamber/1.0.0', codexHome: '/home/dev/.codex', platformFamily: 'unix', platformOs: 'linux' } },
      { await: 'thread/resume' },
      { id: 2, error: { code: -32603, message: 'failed to load config' } },
    ], { engineState: { threadId: THREAD_ID } });

    await expect(proc.start()).rejects.toThrow('failed to load config');
  });

  it('starts the next prompt only after the running turn ends', async () => {
    const handshake = readCodexTranscript('resume-turn').slice(0, 7);
    const started = (n) => [
      { await: 'turn/start' },
      { id: 2 + n, result: { turn: { id: `turn-${n}`, items: [], status: 'inProgress', error: null } } },
      { method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: `turn-${n}`, itemId: `msg-${n}`, delta: `answer ${n}` } },
    ];
    const completed = (n) => ({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: `turn-${n}`, items: [], status: 'completed', error: null } } });
    const { proc, child, events } = startOn([...handshake, ...started(1), ...started(2), completed(2)], {
      engineState: { threadId: THREAD_ID },
    });
    await proc.start();
    const turnStarts = () => child.sent.filter((message) => message.method === 'turn/start');

    proc.sendUserMessage('first');
    proc.sendUserMessage('second');
    await flush();
    expect(turnStarts()).toHaveLength(1);

    const second = new Promise((resolve) => proc.on('turn.completed', () => turnStarts().length === 2 && resolve()));
    child.stdout.write(`${JSON.stringify(completed(1))}\n`);
    await second;

    expect(turnStarts().map((message) => message.params.input[0].text)).toEqual(['first', 'second']);
    expect(named(events, 'text.delta').map(([, payload]) => payload.text)).toEqual(['answer 1', 'answer 2']);
    expect(named(events, 'turn.completed')).toHaveLength(2);
  });

  it('answers a server request it does not handle with an error', async () => {
    const handshake = readCodexTranscript('turn-with-tools').slice(0, 7);
    const { proc, child } = startOn([
      ...handshake,
      { id: 7, method: 'item/tool/requestUserInput', params: { threadId: THREAD_ID, turnId: 't', itemId: 'i', questions: [], isBlocking: true, autoResolutionMs: null } },
      { await: 'response', id: 7 },
    ]);
    await proc.start();
    await flush();

    expect(child.finished).toBe(true);
    expect(child.sent.at(-1)).toEqual({
      id: 7,
      error: { code: -32601, message: 'OpenChamber does not handle item/tool/requestUserInput' },
    });
  });

  it('drops a reply to an approval Codex already resolved', async () => {
    const handshake = readCodexTranscript('turn-with-tools').slice(0, 7);
    const { proc, child, events } = startOn([
      ...handshake,
      { id: 3, method: 'item/fileChange/requestApproval', params: { threadId: THREAD_ID, turnId: 't', itemId: 'i', startedAtMs: 1, reason: 'Write outside the workspace?' } },
      { method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 3 } },
    ]);
    await proc.start();
    await flush();

    const [, request] = events.find(([name]) => name === 'permission.requested');
    expect(request.summary).toBe('Write outside the workspace?');
    proc.respondPermission(request.requestId, 'allow');
    expect(child.sent.some((message) => message.id === 3)).toBe(false);
  });

  it('reports a binary that cannot start', async () => {
    const { proc, child, events } = startOn([]);
    const starting = proc.start();
    child.emit('error', new Error('spawn codex ENOENT'));

    await expect(starting).rejects.toThrow('spawn codex ENOENT');
    expect(proc.isAlive).toBe(false);
    expect(events).toEqual([['error', 'spawn codex ENOENT']]);
  });

  it('stops taking prompts once the app-server exits', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('turn-with-tools').slice(0, 7));
    await proc.start();
    child.exit(1);

    expect(proc.isAlive).toBe(false);
    expect(events).toEqual([['exit', { code: 1, signal: null }]]);
    expect(() => proc.sendUserMessage('too late')).toThrow('Codex app-server is not running');
  });

  it('rejects a permission mode Codex has no policy for', () => {
    expect(() => new CodexProcess({ permissionMode: 'bypassPermissions' })).toThrow('Unknown Codex permission mode');
  });

  it('adds the tool server to the thread and reports its calls by their own names', async () => {
    // The recorded call goes to an MCP server named `docs`, so a tool server
    // of that name stands in for OpenChamber's.
    const toolServer = { name: 'docs', url: 'http://127.0.0.1:3901/api/openchamber/mcp', token: 'tok_secret_value_1234567890' };
    const { proc, child, spawns } = startOn(readCodexTranscript('turn-with-tools'), { toolServer });
    const toolEvents = [];
    for (const name of ['tool.started', 'tool.called', 'tool.completed']) {
      proc.on(name, (payload) => {
        if (payload.id === 'call_docs_search') toolEvents.push([name, payload]);
      });
    }
    proc.on('permission.requested', (request) => setImmediate(() => proc.respondPermission(request.requestId, 'allow')));

    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('The add helper returns the wrong sum. Fix it.');
    await done;

    // The token reaches Codex only through the variable its config names.
    const [{ options }] = spawns;
    expect(options.env.OPENCHAMBER_MCP_TOKEN).toBe(toolServer.token);
    expect(options.env.NO_PROXY.split(',')).toContain('127.0.0.1');
    expect(options.env.PATH).toBe(process.env.PATH);
    const threadStart = child.sent.find((message) => message.method === 'thread/start');
    expect(threadStart.params.config).toEqual({
      mcp_servers: { docs: { url: toolServer.url, bearer_token_env_var: 'OPENCHAMBER_MCP_TOKEN', default_tools_approval_mode: 'approve' } },
    });
    expect(JSON.stringify(child.sent)).not.toContain(toolServer.token);

    expect(toolEvents).toEqual([
      ['tool.started', { id: 'call_docs_search', name: 'search', input: { query: 'add helper contract' } }],
      ['tool.called', { id: 'call_docs_search', name: 'search', input: { query: 'add helper contract' } }],
      ['tool.completed', { id: 'call_docs_search', output: 'add(a, b) returns the sum of a and b.', isError: false }],
    ]);
  });

  it('starts without the tool server when none is given', async () => {
    const { proc, child, spawns } = startOn(readCodexTranscript('turn-with-tools').slice(0, 7));
    await proc.start();
    expect(spawns[0].options).toEqual({ cwd: '/work/app' });
    expect(child.sent.find((message) => message.method === 'thread/start').params.config).toBeUndefined();
  });
});

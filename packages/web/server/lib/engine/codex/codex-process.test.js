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
      config: { features: { default_mode_request_user_input: true } },
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
      ['tool.started', { id: 'call_fix_add', name: 'edit', input: { path: '/work/app/src/math.js' } }],
      ['tool.started', { id: 'call_docs_search', name: 'mcp__docs__search', input: { query: 'add helper contract' } }],
      // The calls already split the two answers into two text parts, so no blank line joins them.
      ['text.delta', { text: 'The fix is to return `a + b` in src/math.js.' }],
      ['text.delta', { text: ' I left the file unchanged because the edit was declined.' }],
      // The total grew from 0 to 39000 input (23500 cached) and 530 output (250
      // reasoning). The last response read 14000 tokens and wrote 80: the
      // context the turn ends with, well below the 39530 the three responses add up to.
      ['turn.completed', { outcome: 'succeeded', usage: { input: 15500, output: 280, reasoning: 250, cacheRead: 23500, cacheWrite: 0, total: 14080 } }],
    ]);
  });

  it('reports commands with their output and exit code, and file changes as writes and edits with their diffs', async () => {
    const { proc } = startOn(readCodexTranscript('turn-with-shell-and-patches'));
    const toolEvents = [];
    for (const name of ['tool.started', 'tool.called', 'tool.completed']) proc.on(name, (payload) => toolEvents.push([name, payload]));

    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('Run the steps.');
    await done;

    const echo = { id: 'exec-946d2e9e-9f66-44af-b34d-c77575479052', name: 'shell', input: { command: "/bin/zsh -lc 'echo hello'", cwd: '/work/app' } };
    const missing = { id: 'exec-8f235dc5-59a9-4633-a766-1afbe2599944', name: 'shell', input: { command: "/bin/zsh -lc 'ls missing-dir'", cwd: '/work/app' } };
    const cat = { id: 'exec-316e90b4-9c20-4b63-afa4-5310f6dec46b', name: 'shell', input: { command: "/bin/zsh -lc 'cat notes.txt'", cwd: '/work/app' } };
    const write = { id: 'exec-755b58b2-f9a8-463c-a338-22eb1e48db5c', name: 'write', input: { path: '/work/app/out.txt', content: 'done\n' } };
    const edit = { id: 'exec-39ab4165-e16a-4012-bdeb-2e2d386c883b', name: 'edit', input: { path: '/work/app/notes.txt' } };
    expect(toolEvents).toEqual([
      ['tool.started', echo],
      ['tool.called', echo],
      ['tool.completed', { id: echo.id, output: 'hello\n', isError: false }],
      ['tool.started', missing],
      ['tool.called', missing],
      ['tool.completed', { id: missing.id, output: 'Exit code 1\nls: missing-dir: No such file or directory\n', isError: true }],
      ['tool.started', cat],
      ['tool.called', cat],
      ['tool.completed', { id: cat.id, output: 'alpha\nbeta\n', isError: false }],
      ['tool.started', write],
      ['tool.called', write],
      ['tool.completed', { id: write.id, output: '', isError: false }],
      ['tool.started', edit],
      ['tool.called', edit],
      ['tool.completed', {
        id: edit.id,
        output: '',
        isError: false,
        metadata: {
          files: [{
            file: '/work/app/notes.txt',
            patch: '--- /work/app/notes.txt\n+++ /work/app/notes.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n',
            additions: 1,
            deletions: 1,
            status: 'modified',
          }],
        },
      }],
    ]);
  });

  it('fails a declined edit with the change it proposed', async () => {
    const { proc } = startOn(readCodexTranscript('turn-with-tools'));
    const completed = [];
    proc.on('tool.completed', (payload) => completed.push(payload));
    proc.on('permission.requested', (request) => setImmediate(() => proc.respondPermission(request.requestId, request.toolName === 'shell' ? 'allow' : 'deny')));

    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('The add helper returns the wrong sum. Fix it.');
    await done;

    expect(completed.slice(0, 2)).toEqual([
      { id: 'call_run_tests', output: 'Exit code 1\nFAIL test/math.test.js\n  add(2, 3): expected 5, received -1\n', isError: true },
      {
        id: 'call_fix_add',
        output: 'The change was declined, so the file was not changed.',
        isError: true,
        metadata: {
          files: [{
            file: '/work/app/src/math.js',
            patch: '--- /work/app/src/math.js\n+++ /work/app/src/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n',
            additions: 1,
            deletions: 1,
            status: 'modified',
          }],
        },
      },
    ]);
  });

  it('sends images as local image inputs and names every other attachment by its path', async () => {
    const { proc, child } = startOn(readCodexTranscript('turn-failed'));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('What is in these?', [
      { kind: 'image', path: '/data/shot.png', mime: 'image/png', size: 10 },
      { kind: 'file', path: '/data/clip.mp4', mime: 'video/mp4', size: 1024 * 1024 },
    ]);
    await done;
    const turnStart = child.sent.find((message) => message.method === 'turn/start');
    expect(turnStart.params.input).toEqual([
      { type: 'text', text: 'What is in these?\n\nAttachment: /data/clip.mp4 (video/mp4, 1 MB)', text_elements: [] },
      { type: 'localImage', path: '/data/shot.png' },
    ]);
  });

  it('ends a failed turn as failed', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('turn-failed'));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('say hi');

    expect(await done).toEqual({
      outcome: 'failed',
      usage: null,
      error: { type: 'CodexTurnFailed', message: 'stream disconnected before completion: URL error: Proxy connection failed: HTTP CONNECT failed with status 403' },
    });
    await flush();
    expect(child.finished).toBe(true);
    // Codex wrote the failed turn to the thread, so the thread can still be resumed.
    expect(events.map(([name]) => name).sort()).toEqual(['engine.state', 'turn.completed']);
  });

  it('fails the turn at the first unauthorized answer and stops Codex retrying', async () => {
    const { proc, child } = startOn(readCodexTranscript('turn-unauthorized'));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('say hi');

    const result = await done;
    expect(result).toMatchObject({ outcome: 'failed', usage: null, error: { type: 'AuthRequired' } });
    expect(result.error.message).toContain('codex login');
    await flush();
    expect(child.finished).toBe(true);
    const interrupt = child.sent.find((message) => message.method === 'turn/interrupt');
    expect(interrupt.params).toEqual({ threadId: '01a14693-ebe8-7543-901a-380f8b4eb0f7', turnId: '01a14693-ec21-7242-829e-0eb7ad130188' });
  });

  it('starts the next prompt only after the interrupted turn ended', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('turn-unauthorized'));
    await proc.start();
    proc.sendUserMessage('say hi');
    proc.sendUserMessage('again');
    await flush();

    expect(sentMethods(child).slice(3)).toEqual(['turn/start', 'turn/interrupt', 'turn/start']);
    expect(named(events, 'turn.completed')).toHaveLength(1);
  });

  it('reads a final unauthorized error without error info as a sign-in problem', async () => {
    const transcript = readCodexTranscript('turn-failed').map((step) => {
      if (step.method !== 'turn/completed') return step;
      const error = { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', codexErrorInfo: 'other' };
      return { ...step, params: { ...step.params, turn: { ...step.params.turn, error } } };
    });
    const { proc } = startOn(transcript);
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('say hi');

    expect(await done).toMatchObject({ outcome: 'failed', error: { type: 'AuthRequired' } });
  });

  it('fails the turn with the reason Codex refused to start it', async () => {
    const transcript = [
      ...readCodexTranscript('turn-failed').slice(0, 8),
      { id: 3, error: { code: -32600, message: 'thread is not loaded' } },
    ];
    const { proc } = startOn(transcript);
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('say hi');

    expect(await done).toEqual({ outcome: 'failed', usage: null, error: { type: 'CodexTurnFailed', message: 'thread is not loaded' } });
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
      usage: { input: 1000, output: 40, reasoning: 0, cacheRead: 14000, cacheWrite: 0, total: 15040 },
    });
    const resume = child.sent.find((message) => message.method === 'thread/resume');
    expect(resume.params).toEqual({
      cwd: '/work/app',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      config: { features: { default_mode_request_user_input: true } },
      threadId: THREAD_ID,
      excludeTurns: true,
    });
    // The session already points at this thread, so there is nothing new to store.
    expect(events.some(([name]) => name === 'engine.state')).toBe(false);
  });

  it('reports the context window Codex states for the model', async () => {
    const transcript = readCodexTranscript('resume-turn').map((step) => (step.method === 'thread/tokenUsage/updated'
      ? { ...step, params: { ...step.params, tokenUsage: { ...step.params.tokenUsage, modelContextWindow: 400_000 } } }
      : step));
    const { proc } = startOn(transcript, { permissionMode: 'never', engineState: { threadId: THREAD_ID } });
    const limits = [];
    proc.on('model.limit', (limit) => limits.push(limit));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('Apply it now.');
    await done;

    expect(limits).toEqual([{ model: 'gpt-6.1-sol', context: 400_000 }]);
  });

  it('reports no context window when Codex states none', async () => {
    const transcript = readCodexTranscript('resume-turn').map((step) => (step.method === 'thread/tokenUsage/updated'
      ? { ...step, params: { ...step.params, tokenUsage: { ...step.params.tokenUsage, modelContextWindow: null } } }
      : step));
    const { proc } = startOn(transcript, { permissionMode: 'never', engineState: { threadId: THREAD_ID } });
    const limits = [];
    proc.on('model.limit', (limit) => limits.push(limit));
    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('Apply it now.');

    expect((await done).outcome).toBe('succeeded');
    expect(limits).toEqual([]);
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
      { id: 7, method: 'mcpServer/elicitation/request', params: { threadId: THREAD_ID, turnId: 't', serverName: 'docs' } },
      { await: 'response', id: 7 },
    ]);
    await proc.start();
    await flush();

    expect(child.finished).toBe(true);
    expect(child.sent.at(-1)).toEqual({
      id: 7,
      error: { code: -32601, message: 'OpenChamber does not handle mcpServer/elicitation/request' },
    });
  });

  it('asks the user Codex\'s request_user_input questions and answers with the picks by question id', async () => {
    const { proc, child, events } = startOn(readCodexTranscript('turn-with-question'));
    const questions = [];
    proc.on('question.requested', (request) => {
      questions.push(request);
      setImmediate(() => proc.respondQuestion(request.requestId, { color: ['Blue'] }));
    });

    await proc.start();
    const done = turnCompleted(proc);
    proc.sendUserMessage('Ask me which color.');
    await done;

    expect(child.finished).toBe(true);
    expect(questions.map(({ requestId: _requestId, ...request }) => request)).toEqual([{
      questions: [{
        id: 'color',
        header: 'Color',
        question: 'Which color?',
        options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }],
        multiple: false,
        custom: true,
      }],
    }]);
    expect(child.sent.find((message) => message.id === 0 && message.method === undefined)).toEqual({
      id: 0,
      result: { answers: { color: { answers: ['Blue'] } } },
    });
    expect(named(events, 'text.delta').map(([, payload]) => payload.text)).toEqual(['Blue']);
    expect(named(events, 'permission.requested')).toEqual([]);
  });

  it('answers a dismissed question with no answers and drops a reply Codex no longer waits for', async () => {
    const handshake = readCodexTranscript('turn-with-tools').slice(0, 7);
    const ask = (id) => ({
      id,
      method: 'item/tool/requestUserInput',
      params: { threadId: THREAD_ID, turnId: 't', itemId: `call_${id}`, questions: [{ id: 'note', header: 'Note', question: 'Anything to add?', isOther: false, isSecret: false, options: null }], isBlocking: false, autoResolutionMs: null },
    });
    const { proc, child } = startOn([
      ...handshake,
      ask(4),
      { await: 'response', id: 4 },
      ask(5),
      { method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 5 } },
    ]);
    const questions = [];
    proc.on('question.requested', (request) => questions.push(request));
    await proc.start();
    await flush();

    expect(questions[0].questions).toEqual([{ id: 'note', header: 'Note', question: 'Anything to add?', options: [], multiple: false, custom: false }]);
    proc.respondQuestion(questions[0].requestId, null);
    await flush();
    expect(child.sent.find((message) => message.id === 4)).toEqual({ id: 4, result: { answers: {} } });

    proc.respondQuestion(questions[1].requestId, { note: ['late'] });
    expect(child.sent.some((message) => message.id === 5)).toBe(false);
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

  it('sends no developer instructions without a tool server', async () => {
    const { proc, child } = startOn(readCodexTranscript('turn-with-tools'), { toolInstructions: 'Use openchamber_web.' });
    await proc.start();
    const threadStart = child.sent.find((message) => message.method === 'thread/start');
    expect(threadStart.params.developerInstructions).toBeUndefined();
  });

  it('rejects a permission mode Codex has no policy for', () => {
    expect(() => new CodexProcess({ permissionMode: 'bypassPermissions' })).toThrow('Unknown Codex permission mode');
  });

  it('adds the tool server to the thread and reports its calls by their own names', async () => {
    // The recorded call goes to an MCP server named `docs`, so a tool server
    // of that name stands in for OpenChamber's.
    const toolServer = { name: 'docs', url: 'http://127.0.0.1:3901/api/openchamber/mcp', token: 'tok_secret_value_1234567890' };
    const { proc, child, spawns } = startOn(readCodexTranscript('turn-with-tools'), { toolServer, toolInstructions: 'Use openchamber_web.' });
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
      features: { default_mode_request_user_input: true },
      mcp_servers: { docs: { url: toolServer.url, bearer_token_env_var: 'OPENCHAMBER_MCP_TOKEN', default_tools_approval_mode: 'approve' } },
    });
    expect(JSON.stringify(child.sent)).not.toContain(toolServer.token);
    expect(threadStart.params.developerInstructions).toBe('Use openchamber_web.');

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
    expect(child.sent.find((message) => message.method === 'thread/start').params.config).toEqual({ features: { default_mode_request_user_input: true } });
  });
});

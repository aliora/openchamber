import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createLoginSessions, findDeviceCode, findLoginUrl, toPlainText } from './login-session.js';

const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz';
const CLAUDE_OUTPUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${CLAUDE_URL}\x07\x1b[94m${CLAUDE_URL}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `;
const CODEX_OUTPUT = '\r\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94m45ZG-EBSFY\x1b[0m\r\n\r\n';
const AGY_URL = `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=${'1'.repeat(40)}-x.apps.googleusercontent.com&code_challenge=${'a'.repeat(60)}&state=done`;

const wrapAt = (text, width) => text.match(new RegExp(`.{1,${width}}`, 'g'));

describe('login output', () => {
  it('strips colours, OSC links and cursor moves', () => {
    expect(toPlainText('\x1b[94mhi\x1b[0m\x1b]8;;https://x.example\x07there\x1b]8;;\x07\r\nnext\x1b[4Gcol')).toBe('hithere\nnext\ncol');
  });

  it('finds the URL in Claude, Codex and agy output', () => {
    expect(findLoginUrl(CLAUDE_OUTPUT)).toBe(CLAUDE_URL);
    expect(findLoginUrl(CODEX_OUTPUT)).toBe('https://auth.openai.com/codex/device');
  });

  it('joins a URL the CLI wrapped over several lines', () => {
    const wrapped = wrapAt(AGY_URL, 99).map((line) => ` \x1b[34;4m${line}\x1b[m`).join('\r\n');
    expect(findLoginUrl(`Your browser should open automatically. If not:\r\n\r\n${wrapped}\r\n\r\n Copy and paste the URL\r\n`)).toBe(AGY_URL);
  });

  it('prefers the first https URL that is not on this machine', () => {
    expect(findLoginUrl('callback on http://localhost:1455/cb and https://127.0.0.1:9/x\nthen (https://one.example/a).\nhttps://two.example/b\n')).toBe('https://one.example/a');
    expect(findLoginUrl('only http://example.com/x\n')).toBeNull();
  });

  it('finds a device code printed on its own line', () => {
    expect(findDeviceCode(CODEX_OUTPUT)).toBe('45ZG-EBSFY');
    expect(findDeviceCode(CLAUDE_OUTPUT)).toBeNull();
    expect(findDeviceCode('Released 2026-10-18\nUse READ ONLY\n')).toBeNull();
  });
});

const createFakePty = () => {
  const events = new EventEmitter();
  const pty = {
    pid: 0,
    written: [],
    killed: false,
    onData: (listener) => events.on('data', listener),
    onExit: (listener) => events.on('exit', listener),
    write: (data) => pty.written.push(data),
    kill: () => {
      pty.killed = true;
    },
    print: (text) => events.emit('data', text),
    exit: (exitCode) => events.emit('exit', { exitCode, signal: 0 }),
  };
  return pty;
};

const createHarness = ({ loggedIn = false, prompts } = {}) => {
  const ptys = [];
  const spawns = [];
  const settled = [];
  const adapter = {
    id: 'claude',
    displayName: 'Claude Code',
    auth: {
      status: async () => ({ loggedIn: adapter.signedIn }),
      loginProcess: () => ({ command: '/bin/claude', args: ['auth', 'login'], prompts }),
    },
    signedIn: loggedIn,
  };
  const sessions = createLoginSessions({
    spawnPty: async (command, args, options) => {
      spawns.push({ command, args, options });
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
    pollMs: 5,
    enterDelayMs: 0,
    env: { PATH: '/bin', NODE_CHANNEL_FD: '3' },
    cwd: '/home/me',
    onSettled: (engine) => settled.push(engine.id),
  });
  return { adapter, sessions, ptys, spawns, settled };
};

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (check) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await tick(10);
};

describe('login sessions', () => {
  it('runs the login command in a pty and reports the link and the code prompt', async () => {
    const { adapter, sessions, ptys, spawns } = createHarness();
    expect((await sessions.start(adapter)).state).toBe('starting');
    expect(spawns[0]).toMatchObject({ command: '/bin/claude', args: ['auth', 'login'], options: { cwd: '/home/me' } });
    expect(spawns[0].options.env.NODE_CHANNEL_FD).toBeUndefined();

    ptys[0].print(CLAUDE_OUTPUT);
    expect(sessions.get(adapter)).toMatchObject({ state: 'waiting', url: CLAUDE_URL, code: null, needsInput: true });
    expect(sessions.get(adapter).outputTail).toContain('Paste code here');
    await sessions.cancel(adapter);
  });

  it('keeps one session per engine', async () => {
    const { adapter, sessions, spawns } = createHarness();
    await Promise.all([sessions.start(adapter), sessions.start(adapter)]);
    await sessions.start(adapter);
    expect(spawns).toHaveLength(1);
    await sessions.cancel(adapter);
  });

  it('types the code and then Enter', async () => {
    const { adapter, sessions, ptys } = createHarness();
    await sessions.start(adapter);
    ptys[0].print(CLAUDE_OUTPUT);
    expect(sessions.input(adapter, 'abc#def')).not.toBeNull();
    await until(() => ptys[0].written.length === 2);
    expect(ptys[0].written).toEqual(['abc#def', '\r']);
    await sessions.cancel(adapter);
  });

  it('answers a prompt the adapter names once', async () => {
    const { adapter, sessions, ptys } = createHarness({ prompts: [{ match: /login method/i, send: '\r' }] });
    await sessions.start(adapter);
    ptys[0].print('Select login method:\r\n');
    ptys[0].print('Select login method:\r\n');
    expect(ptys[0].written).toEqual(['\r']);
    await sessions.cancel(adapter);
  });

  it('succeeds once the engine reports signed in, then stops the CLI', async () => {
    const { adapter, sessions, ptys, settled } = createHarness();
    await sessions.start(adapter);
    adapter.signedIn = true;
    await until(() => sessions.get(adapter).state === 'succeeded');
    expect(sessions.get(adapter).state).toBe('succeeded');
    expect(ptys[0].killed).toBe(true);
    expect(settled).toEqual(['claude']);
  });

  it('does not take an account that was signed in at the start as success', async () => {
    const { adapter, sessions, ptys } = createHarness({ loggedIn: true });
    await sessions.start(adapter);
    await tick();
    expect(sessions.get(adapter).state).toBe('starting');
    ptys[0].exit(0);
    expect(sessions.get(adapter).state).toBe('succeeded');
  });

  it('fails when the CLI exits with an error', async () => {
    const { adapter, sessions, ptys } = createHarness();
    await sessions.start(adapter);
    ptys[0].exit(1);
    expect(sessions.get(adapter)).toMatchObject({ state: 'failed', message: 'Claude Code sign-in exited with code 1' });
    expect(sessions.input(adapter, 'late')).toBeNull();
  });

  it('cancels, and a new start runs the CLI again', async () => {
    const { adapter, sessions, ptys, spawns } = createHarness();
    await sessions.start(adapter);
    expect((await sessions.cancel(adapter)).state).toBe('cancelled');
    expect(ptys[0].killed).toBe(true);
    await sessions.start(adapter);
    expect(spawns).toHaveLength(2);
    await sessions.cancel(adapter);
  });

  it('gives up after the time limit', async () => {
    const { adapter } = createHarness();
    const sessions = createLoginSessions({ spawnPty: async () => createFakePty(), timeoutMs: 10, pollMs: 1000, onSettled: () => {} });
    await sessions.start(adapter);
    await until(() => sessions.get(adapter).state === 'failed');
    expect(sessions.get(adapter)).toMatchObject({ state: 'failed', message: 'Sign-in timed out' });
  });

  it('reports a CLI that cannot start', async () => {
    const { adapter } = createHarness();
    const sessions = createLoginSessions({ spawnPty: async () => { throw new Error('spawn ENOENT'); }, onSettled: () => {} });
    expect(await sessions.start(adapter)).toMatchObject({ state: 'failed', message: 'spawn ENOENT' });
  });

  it('answers idle when nothing ran', () => {
    const { adapter, sessions } = createHarness();
    expect(sessions.get(adapter)).toEqual({ state: 'idle', url: null, code: null, needsInput: false, message: null, outputTail: '' });
  });
});

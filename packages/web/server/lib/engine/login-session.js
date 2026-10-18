import os from 'node:os';

const OUTPUT_LIMIT = 64 * 1024;
const TAIL_CHARS = 4000;
const WRAPPED_LINE_MIN = 60;
const PTY_SIZE = { cols: 200, rows: 50 };
const ACTIVE = new Set(['starting', 'waiting']);

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const OSC8_TARGET = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*([@-~])/g;
const OTHER_ESCAPE = /\x1b[()#][0-9A-Za-z]|\x1b[0-~]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const LINE_BREAKING_CSI = new Set(['A', 'B', 'E', 'F', 'G', 'H', 'd', 'f']);
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;
const URL_TAIL = /https?:\/\/\S*$/;
const URL_CHARS = /^[\w\-.~:/?#[\]@!$&'()*+,;=%]+$/;
const TRAILING_PUNCTUATION = /[).,;:!?\]}>]+$/;
const DEVICE_CODE_LINE = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/m;
const NEEDS_INPUT = /\bpaste\b/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

const csiToText = (_sequence, final) => {
  if (final === 'C') return ' ';
  return LINE_BREAKING_CSI.has(final) ? '\n' : '';
};

export const toPlainText = (raw) => raw
  .replace(OSC, '')
  .replace(CSI, csiToText)
  .replace(OTHER_ESCAPE, '')
  .replace(/\r\n?/g, '\n')
  .replace(CONTROL, '');

const joinWrappedUrls = (text) => {
  const lines = [];
  let previous = '';
  for (const line of text.split('\n')) {
    const piece = line.trim();
    const continuesUrl = previous.length >= WRAPPED_LINE_MIN && URL_TAIL.test(lines.at(-1) ?? '') && URL_CHARS.test(piece);
    if (continuesUrl) lines[lines.length - 1] += piece;
    else lines.push(line);
    previous = line.trimEnd();
  }
  return lines.join('\n');
};

const isRemoteHttps = (url) => {
  if (!url.startsWith('https://') || !URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return !LOOPBACK_HOSTS.has(host) && !host.startsWith('127.');
};

/** The first https link in the output that does not point at this machine. */
export const findLoginUrl = (raw) => {
  const linked = [...raw.matchAll(OSC8_TARGET)].map((match) => match[1]);
  const printed = joinWrappedUrls(toPlainText(raw)).match(URL_IN_TEXT) ?? [];
  const candidates = [...linked, ...printed].map((url) => url.replace(TRAILING_PUNCTUATION, ''));
  return candidates.find(isRemoteHttps) ?? null;
};

/** A one-time code such as `ABCD-1234` that the CLI prints on a line of its own. */
export const findDeviceCode = (raw) => toPlainText(raw).match(DEVICE_CODE_LINE)?.[1] ?? null;

const loadPtySpawn = async () => {
  const pty = typeof globalThis.Bun === 'undefined' ? await import('node-pty') : await import('bun-pty');
  return pty.spawn;
};

const spawnSystemPty = async (command, args, options) => (await loadPtySpawn())(command, args, options);

const toLaunch = ({ command, args = [], shell = false }) => (shell
  ? { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  : { command, args });

const loginEnv = (env) => {
  const next = { ...env, TERM: 'xterm-256color' };
  delete next.NODE_CHANNEL_FD;
  return next;
};

const stopProcess = (pty) => {
  if (process.platform !== 'win32' && pty.pid > 0) {
    try {
      process.kill(-pty.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  pty.kill();
};

const readSignedIn = (adapter) => Promise.resolve()
  .then(() => adapter.auth.status())
  .then((status) => Boolean(status?.loggedIn), () => false);

const IDLE = Object.freeze({ state: 'idle', url: null, code: null, needsInput: false, message: null, outputTail: '' });

export const createLoginSessions = ({
  spawnPty = spawnSystemPty,
  pollMs = 2000,
  timeoutMs = 10 * 60 * 1000,
  enterDelayMs = 300,
  env = process.env,
  cwd = os.homedir(),
  onSettled,
}) => {
  const sessions = new Map();

  const snapshot = (session) => {
    if (!session) return { ...IDLE };
    const plain = toPlainText(session.output);
    return {
      state: session.state,
      url: session.url,
      code: session.code,
      needsInput: ACTIVE.has(session.state) && NEEDS_INPUT.test(plain),
      message: session.message,
      outputTail: plain.slice(-TAIL_CHARS),
    };
  };

  const finish = (session, state, message = null) => {
    if (!ACTIVE.has(session.state)) return;
    session.state = state;
    session.message = message;
    clearInterval(session.poller);
    clearTimeout(session.timer);
    if (session.pty && !session.exited) stopProcess(session.pty);
    onSettled(session.adapter);
  };

  const readOutput = (session, chunk, prompts) => {
    session.output = (session.output + chunk).slice(-OUTPUT_LIMIT);
    const complete = session.output.slice(0, session.output.lastIndexOf('\n') + 1);
    session.url = findLoginUrl(complete) ?? session.url;
    session.code ??= findDeviceCode(complete);
    if (session.state === 'starting' && (session.url || session.code)) session.state = 'waiting';
    const plain = toPlainText(session.output);
    prompts.forEach((prompt, index) => {
      if (session.answered.has(index) || !prompt.match.test(plain)) return;
      session.answered.add(index);
      session.pty.write(prompt.send);
    });
  };

  const pollStatus = async (session) => {
    if (session.polling) return;
    session.polling = true;
    const signedIn = await readSignedIn(session.adapter);
    session.polling = false;
    if (signedIn) finish(session, 'succeeded');
  };

  const run = async (session) => {
    const { adapter } = session;
    const spec = adapter.auth.loginProcess();
    const signedInAtStart = await readSignedIn(adapter);
    const launch = toLaunch(spec);
    let pty;
    try {
      pty = await spawnPty(launch.command, launch.args, { name: 'xterm-256color', ...PTY_SIZE, cwd, env: loginEnv(env) });
    } catch (error) {
      finish(session, 'failed', error?.message ?? String(error));
      return;
    }
    session.pty = pty;
    if (!ACTIVE.has(session.state)) {
      stopProcess(pty);
      return;
    }
    pty.onData((chunk) => readOutput(session, chunk, spec.prompts ?? []));
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      if (exitCode === 0) finish(session, 'succeeded');
      else finish(session, 'failed', `${adapter.displayName} sign-in exited with code ${exitCode}`);
    });
    if (!signedInAtStart) session.poller = setInterval(() => void pollStatus(session), pollMs);
    session.timer = setTimeout(() => finish(session, 'failed', 'Sign-in timed out'), timeoutMs);
  };

  const activeSession = (adapter) => {
    const session = sessions.get(adapter.id);
    return session && ACTIVE.has(session.state) ? session : null;
  };

  return {
    start: async (adapter) => {
      const current = sessions.get(adapter.id);
      if (current && ACTIVE.has(current.state)) {
        await current.ready;
        return snapshot(current);
      }
      const session = { adapter, state: 'starting', url: null, code: null, message: null, output: '', pty: null, exited: false, answered: new Set(), polling: false };
      sessions.set(adapter.id, session);
      session.ready = run(session);
      await session.ready;
      return snapshot(session);
    },
    get: (adapter) => snapshot(sessions.get(adapter.id)),
    input: (adapter, text) => {
      const session = activeSession(adapter);
      if (!session?.pty) return null;
      session.pty.write(text);
      setTimeout(() => {
        if (ACTIVE.has(session.state)) session.pty.write('\r');
      }, enterDelayMs);
      return snapshot(session);
    },
    cancel: async (adapter) => {
      const session = sessions.get(adapter.id);
      if (!session) return snapshot(null);
      await session.ready;
      finish(session, 'cancelled');
      return snapshot(session);
    },
  };
};

import { execFile } from 'node:child_process';

const CONNECTED_TTL_MS = 30_000;
const DISCONNECTED_TTL_MS = 10_000;

let remembered = null;
let pending = null;

const run = (execFileFn, command, args, env) => new Promise((resolve) => {
  execFileFn(command, args, { encoding: 'utf8', timeout: 6000, env, windowsHide: true }, (error, stdout) => {
    resolve({ error, stdout: `${stdout || ''}` });
  });
});

const readStatus = (execFileFn, command, env) => run(execFileFn, command, ['auth', 'status', '--json'], env);

const resolveFromLoginShell = async (execFileFn, env, platform) => {
  if (platform === 'win32') {
    const result = await run(execFileFn, 'where', ['claude'], env);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = await run(execFileFn, shell, ['-lic', 'command -v claude'], env);
  return result.stdout.trim().split(/\s+/).pop() || null;
};

const checkClaudeCliAuthStatus = async ({ execFileFn, env, platform }) => {
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    let result = await readStatus(execFileFn, 'claude', childEnv);
    if (!result.stdout.trim() && result.error) {
      const resolved = await resolveFromLoginShell(execFileFn, childEnv, platform);
      if (resolved) result = await readStatus(execFileFn, resolved, childEnv);
    }
    const output = result.stdout.trim();
    if (!output) return { connected: false, reason: 'empty-status' };
    const payload = JSON.parse(output);
    return {
      connected: payload?.loggedIn === true,
      reason: payload?.loggedIn === true ? 'logged-in' : 'logged-out',
    };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const forgetClaudeCliAuthStatus = () => {
  remembered = null;
  pending = null;
};

export const getClaudeCliAuthStatus = ({
  execFileFn = execFile,
  env = process.env,
  platform = process.platform,
} = {}) => {
  if (remembered && remembered.expiresAt > Date.now()) {
    return Promise.resolve(remembered.status);
  }
  if (pending) {
    return pending;
  }
  const lookup = checkClaudeCliAuthStatus({ execFileFn, env, platform }).then((status) => {
    if (pending === lookup) {
      remembered = { status, expiresAt: Date.now() + (status.connected ? CONNECTED_TTL_MS : DISCONNECTED_TTL_MS) };
      pending = null;
    }
    return status;
  });
  pending = lookup;
  return lookup;
};

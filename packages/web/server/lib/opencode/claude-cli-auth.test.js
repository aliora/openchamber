import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';

import { forgetClaudeCliAuthStatus, getClaudeCliAuthStatus } from './claude-cli-auth.js';

const answering = (respond) => {
  const invocations = [];
  const execFileFn = (command, args, options, callback) => {
    invocations.push({ command, args, options });
    const { error = null, stdout = '' } = respond(command, args);
    callback(error, stdout, '');
  };
  return { execFileFn, invocations };
};

const loggedIn = () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }) });
const loggedOut = () => ({ stdout: JSON.stringify({ loggedIn: false }) });

describe('getClaudeCliAuthStatus', () => {
  beforeEach(() => {
    setSystemTime(new Date('2026-10-20T08:00:00Z'));
    forgetClaudeCliAuthStatus();
  });

  afterEach(() => {
    setSystemTime();
  });

  test('reports the authoritative Claude CLI login state', async () => {
    const { execFileFn, invocations } = answering(loggedIn);

    const status = await getClaudeCliAuthStatus({
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak',
      },
      execFileFn,
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocations[0].command).toBe('claude');
    expect(invocations[0].args).toEqual(['auth', 'status', '--json']);
    expect(invocations[0].options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('ignores a stale OpenCode marker when the CLI is logged out', async () => {
    const { execFileFn } = answering(loggedOut);

    await expect(getClaudeCliAuthStatus({ execFileFn })).resolves.toEqual({ connected: false, reason: 'logged-out' });
  });

  test('reads the login state a CLI prints before exiting with an error', async () => {
    const { execFileFn } = answering(() => ({ error: Object.assign(new Error('Command failed'), { code: 1 }), ...loggedOut() }));

    await expect(getClaudeCliAuthStatus({ execFileFn })).resolves.toEqual({ connected: false, reason: 'logged-out' });
  });

  test('finds Claude through a login shell when a desktop PATH cannot', async () => {
    const { execFileFn, invocations } = answering((command) => {
      if (command === 'claude') return { error: new Error('spawn claude ENOENT') };
      if (command === '/bin/zsh') return { stdout: '/Users/test/.local/bin/claude\n' };
      return loggedIn();
    });

    const status = await getClaudeCliAuthStatus({
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      platform: 'darwin',
      execFileFn,
    });

    expect(status).toEqual({ connected: true, reason: 'logged-in' });
    expect(invocations.map(({ command }) => command)).toEqual([
      'claude',
      '/bin/zsh',
      '/Users/test/.local/bin/claude',
    ]);
    expect(invocations[1].args).toEqual(['-lic', 'command -v claude']);
  });

  test('shares one check between concurrent callers', async () => {
    const pending = [];
    const execFileFn = (_command, _args, _options, callback) => pending.push(callback);

    const first = getClaudeCliAuthStatus({ execFileFn });
    const second = getClaudeCliAuthStatus({ execFileFn });
    pending.forEach((callback) => callback(null, loggedIn().stdout, ''));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { connected: true, reason: 'logged-in' },
      { connected: true, reason: 'logged-in' },
    ]);
    expect(pending).toHaveLength(1);
  });

  test('keeps a login for 30 seconds, then asks the CLI again', async () => {
    const { execFileFn, invocations } = answering(loggedIn);

    await getClaudeCliAuthStatus({ execFileFn });
    setSystemTime(new Date('2026-10-20T08:00:29Z'));
    await getClaudeCliAuthStatus({ execFileFn });
    expect(invocations).toHaveLength(1);

    setSystemTime(new Date('2026-10-20T08:00:31Z'));
    await getClaudeCliAuthStatus({ execFileFn });
    expect(invocations).toHaveLength(2);
  });

  test('remembers a missing login for 10 seconds, then asks the CLI again', async () => {
    const { execFileFn, invocations } = answering(loggedOut);

    await getClaudeCliAuthStatus({ execFileFn });
    setSystemTime(new Date('2026-10-20T08:00:09Z'));
    await getClaudeCliAuthStatus({ execFileFn });
    expect(invocations).toHaveLength(1);

    setSystemTime(new Date('2026-10-20T08:00:11Z'));
    await getClaudeCliAuthStatus({ execFileFn });
    expect(invocations).toHaveLength(2);
  });
});

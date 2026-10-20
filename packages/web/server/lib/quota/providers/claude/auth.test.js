import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.fn();
const files = new Map();

vi.mock('child_process', () => ({
  execFile: (file, args, options, callback) => {
    try {
      callback(null, keychain(file, args, options), '');
    } catch (error) {
      callback(error, '', '');
    }
  },
}));

vi.mock('fs', () => {
  const fs = {
    existsSync: (filePath) => files.has(filePath),
    readFileSync: (filePath) => {
      if (!files.has(filePath)) throw new Error('ENOENT');
      return files.get(filePath);
    },
  };
  return { ...fs, default: fs };
});

import { findClaudeCredential } from './auth.js';

const claudeCodeBlob = (accessToken) => JSON.stringify({
  mcpOAuth: { 'linear|abc': { accessToken: 'unrelated-mcp-token' } },
  claudeAiOauth: {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: 1786735755912,
    subscriptionType: 'max',
  },
});

const withPlatform = async (platform, run) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
};

beforeEach(() => {
  files.clear();
  keychain.mockReset();
  keychain.mockImplementation(() => { throw new Error('no keychain entry'); });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe('Claude credential discovery', () => {
  it('prefers the macOS Keychain over a stale credentials file', async () => {
    keychain.mockReturnValue(claudeCodeBlob('keychain-token'));
    files.set(`${process.env.HOME}/.claude/.credentials.json`, claudeCodeBlob('file-token'));

    const credential = await withPlatform('darwin', findClaudeCredential);

    expect(credential.accessToken).toBe('keychain-token');
    expect(credential.refreshToken).toBe('keychain-token-refresh');
    expect(credential.planLabel).toBe('max');
    expect(credential.source).toBe('keychain');
    expect(keychain).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 10_000 },
    );
  });

  it('shares one Keychain read between concurrent callers and reads fresh afterwards', async () => {
    keychain.mockReturnValue(claudeCodeBlob('first-token'));

    const [first, second] = await withPlatform('darwin', () => Promise.all([findClaudeCredential(), findClaudeCredential()]));
    expect(first.accessToken).toBe('first-token');
    expect(second.accessToken).toBe('first-token');
    expect(keychain).toHaveBeenCalledTimes(1);

    keychain.mockReturnValue(claudeCodeBlob('rotated-token'));
    const rotated = await withPlatform('darwin', findClaudeCredential);
    expect(rotated.accessToken).toBe('rotated-token');
    expect(keychain).toHaveBeenCalledTimes(2);
  });

  it('reads the credentials file on Linux, where there is no Keychain', async () => {
    files.set(`${process.env.HOME}/.claude/.credentials.json`, claudeCodeBlob('file-token'));

    const credential = await withPlatform('linux', findClaudeCredential);

    expect(keychain).not.toHaveBeenCalled();
    expect(credential.accessToken).toBe('file-token');
    expect(credential.source).toBe('credentials-file');
  });

  it('honours CLAUDE_CONFIG_DIR when locating the credentials file', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-home';
    files.set('/tmp/claude-home/.credentials.json', claudeCodeBlob('custom-dir-token'));

    expect((await withPlatform('linux', findClaudeCredential)).accessToken).toBe('custom-dir-token');
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN last, without a refresh token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

    const credential = await withPlatform('linux', findClaudeCredential);

    expect(credential.accessToken).toBe('env-token');
    expect(credential.refreshToken).toBeNull();
    expect(credential.source).toBe('env');
  });

  it('ignores a Keychain blob that only holds unrelated MCP tokens', async () => {
    keychain.mockReturnValue(JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'unrelated' } } }));

    expect(await withPlatform('darwin', findClaudeCredential)).toBeNull();
  });

  it('returns null when every source is empty', async () => {
    expect(await withPlatform('darwin', findClaudeCredential)).toBeNull();
  });

  it('reports no credential, without throwing, when the credentials file holds invalid JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.set(`${process.env.HOME}/.claude/.credentials.json`, '{"claudeAiOauth": {"accessToken": "secret-token-value"');

    expect(await withPlatform('linux', findClaudeCredential)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token-value');
    warn.mockRestore();
  });
});

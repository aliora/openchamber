import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
const files = new Map();

vi.mock('child_process', () => ({ execFileSync: (...args) => execFileSync(...args) }));

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

const withPlatform = (platform, run) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
};

beforeEach(() => {
  files.clear();
  execFileSync.mockReset();
  execFileSync.mockImplementation(() => { throw new Error('no keychain entry'); });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe('Claude credential discovery', () => {
  it('prefers the macOS Keychain over a stale credentials file', () => {
    execFileSync.mockReturnValue(claudeCodeBlob('keychain-token'));
    files.set(`${process.env.HOME}/.claude/.credentials.json`, claudeCodeBlob('file-token'));

    const credential = withPlatform('darwin', findClaudeCredential);

    expect(credential.accessToken).toBe('keychain-token');
    expect(credential.refreshToken).toBe('keychain-token-refresh');
    expect(credential.planLabel).toBe('max');
    expect(credential.source).toBe('keychain');
  });

  it('reads the credentials file on Linux, where there is no Keychain', () => {
    files.set(`${process.env.HOME}/.claude/.credentials.json`, claudeCodeBlob('file-token'));

    const credential = withPlatform('linux', findClaudeCredential);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(credential.accessToken).toBe('file-token');
    expect(credential.source).toBe('credentials-file');
  });

  it('honours CLAUDE_CONFIG_DIR when locating the credentials file', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-home';
    files.set('/tmp/claude-home/.credentials.json', claudeCodeBlob('custom-dir-token'));

    expect(withPlatform('linux', findClaudeCredential).accessToken).toBe('custom-dir-token');
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN last, without a refresh token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

    const credential = withPlatform('linux', findClaudeCredential);

    expect(credential.accessToken).toBe('env-token');
    expect(credential.refreshToken).toBeNull();
    expect(credential.source).toBe('env');
  });

  it('ignores a Keychain blob that only holds unrelated MCP tokens', () => {
    execFileSync.mockReturnValue(JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'unrelated' } } }));

    expect(withPlatform('darwin', findClaudeCredential)).toBeNull();
  });

  it('returns null when every source is empty', () => {
    expect(withPlatform('darwin', findClaudeCredential)).toBeNull();
  });

  it('reports no credential, without throwing, when the credentials file holds invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.set(`${process.env.HOME}/.claude/.credentials.json`, '{"claudeAiOauth": {"accessToken": "secret-token-value"');

    expect(withPlatform('linux', findClaudeCredential)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token-value');
    warn.mockRestore();
  });
});

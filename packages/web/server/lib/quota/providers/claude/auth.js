/**
 * Claude credential discovery.
 *
 * Reads the login Claude Code itself keeps: on macOS its OAuth tokens live in
 * the login Keychain, elsewhere in a credentials file. `CLAUDE_CODE_OAUTH_TOKEN`
 * is Claude Code's own environment override and comes last.
 *
 * Every source is read-only. Claude rotates a Keychain/credentials entry from
 * under us whenever Claude Code refreshes, so credentials are read fresh per
 * request rather than cached; a stale cached token would outlive the record it
 * came from.
 *
 * @module quota/providers/claude/auth
 */

import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import { asObject, asNonEmptyString, normalizeTimestamp, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * @typedef {object} ClaudeCredential
 * @property {string} accessToken
 * @property {string|null} refreshToken
 * @property {number|null} expiresAt Epoch milliseconds, when the source reports it.
 * @property {string|null} planLabel Subscription tier reported by Claude Code, e.g. `max`.
 * @property {'keychain'|'credentials-file'|'env'} source
 */

const claudeConfigDirectory = () => {
  const override = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
};

/**
 * Claude Code writes one JSON blob holding both its own OAuth tokens
 * (`claudeAiOauth`) and unrelated MCP server tokens. Only the former is read.
 */
const parseClaudeCodeBlob = (blob, source) => {
  const oauth = asObject(asObject(blob)?.claudeAiOauth);
  const accessToken = asNonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth.refreshToken),
    expiresAt: normalizeTimestamp(oauth.expiresAt),
    planLabel: asNonEmptyString(oauth.subscriptionType),
    source
  };
};

const readKeychainCredential = () => {
  if (process.platform !== 'darwin') return null;
  let raw;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    // No entry, or the user denied Keychain access. Both mean "try the next source".
    return null;
  }
  try {
    return parseClaudeCodeBlob(JSON.parse(raw.trim()), 'keychain');
  } catch {
    console.warn('Claude quota: Keychain credentials are not valid JSON');
    return null;
  }
};

const readCredentialsFile = () =>
  parseClaudeCodeBlob(readJsonFile(path.join(claudeConfigDirectory(), '.credentials.json')), 'credentials-file');

const readEnvCredential = () => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

/**
 * First credential a source can produce, in priority order.
 *
 * The Keychain wins over the credentials file because on macOS the file is a
 * leftover that Claude Code no longer updates. Nothing signed in is `null`,
 * which callers report as "not configured", not as an error.
 *
 * @returns {ClaudeCredential|null}
 */
export const findClaudeCredential = () =>
  readKeychainCredential()
  ?? readCredentialsFile()
  ?? readEnvCredential();

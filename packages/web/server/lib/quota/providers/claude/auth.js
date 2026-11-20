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
 * came from. The Keychain read runs as a child process the caller awaits, and
 * concurrent callers share the read in flight.
 *
 * @module quota/providers/claude/auth
 */

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import { asObject, asNonEmptyString, normalizeTimestamp, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const keychainServiceFor = (configDir) => {
  if (!configDir) return KEYCHAIN_SERVICE;
  const hash = createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
};

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

const pendingKeychainReads = new Map();

const readKeychainSecret = (service) => new Promise((resolve) => {
  execFile('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
    // No entry, or the user denied Keychain access. Both mean "try the next source".
    resolve(error ? null : stdout);
  });
});

const parseKeychainSecret = (raw) => {
  if (raw === null) return null;
  try {
    return parseClaudeCodeBlob(JSON.parse(raw.trim()), 'keychain');
  } catch {
    console.warn('Claude quota: Keychain credentials are not valid JSON');
    return null;
  }
};

const readKeychainCredential = (service = KEYCHAIN_SERVICE) => {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  let pending = pendingKeychainReads.get(service);
  if (!pending) {
    pending = readKeychainSecret(service)
      .then(parseKeychainSecret)
      .finally(() => { pendingKeychainReads.delete(service); });
    pendingKeychainReads.set(service, pending);
  }
  return pending;
};

const readCredentialsFile = (configDir = claudeConfigDirectory()) =>
  parseClaudeCodeBlob(readJsonFile(path.join(configDir, '.credentials.json')), 'credentials-file');

const readEnvCredential = () => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

/**
 * First credential a source can produce, in priority order.
 *
 * The Keychain wins over the credentials file because on macOS the file is a
 * leftover that Claude Code no longer updates. When `configDir` is given for a
 * named account, only that profile's Keychain service and credentials file are
 * checked so an unauthenticated profile never falls back to the ambient login.
 * Nothing signed in is `null`, which callers report as "not configured", not as
 * an error.
 *
 * @param {{ configDir?: string }} [options]
 * @returns {Promise<ClaudeCredential|null>}
 */
export const findClaudeCredential = async ({ configDir } = {}) => {
  if (configDir) {
    const resolvedDir = path.resolve(configDir);
    return (await readKeychainCredential(keychainServiceFor(resolvedDir)))
      ?? readCredentialsFile(resolvedDir);
  }
  const envDir = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  const service = envDir ? keychainServiceFor(envDir) : KEYCHAIN_SERVICE;
  return (await readKeychainCredential(service))
    ?? readCredentialsFile()
    ?? readEnvCredential();
};

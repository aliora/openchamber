import { describe, expect, test } from 'bun:test';
import type { EngineAuth, EngineSnapshot, EngineStatus } from '@/components/setup-wizard/engineSetupModel';
import {
  deriveActionOffers,
  deriveCardStatus,
  deriveSignIn,
  deriveVersion,
  troubleshootingCommands,
} from './engineManagement';

const baseStatus: EngineStatus = {
  engine: 'claude',
  displayName: 'Claude Code',
  providerID: 'anthropic',
  installed: true,
  version: '2.1.3',
  latestVersion: '2.1.3',
  updateAvailable: false,
  canInstall: true,
  installCommand: 'npm install -g @anthropic-ai/claude-code',
  state: 'idle',
  lastError: null,
  installSource: 'native',
  actions: { install: true, update: true, reinstall: true, uninstall: true, doctor: false },
  commands: {
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    update: 'claude update',
    reinstall: 'claude install latest --force',
    uninstall: null,
    doctor: 'claude doctor',
    login: 'claude auth login',
    logout: 'claude auth logout',
  },
  currentAction: null,
  rawVersion: '2.1.3 (Claude Code)',
  commandPath: '/Users/me/.local/bin/claude',
  detectionError: null,
};

const snapshot = (status: Partial<EngineStatus> = {}, readiness: EngineSnapshot['readiness'] = 'ready', fixCommand: string | null = null): EngineSnapshot => ({
  status: { ...baseStatus, ...status },
  readiness,
  fixCommand,
});

const signedIn: EngineAuth = { loggedIn: true, email: 'me@example.com', method: 'claude.ai', plan: 'max' };

describe('deriveActionOffers', () => {
  test('a missing CLI offers only install', () => {
    expect(deriveActionOffers(snapshot({ installed: false, version: null }).status)).toEqual([{ action: 'install', mode: 'server' }]);
  });

  test('a current CLI offers maintenance without update, doctor as a command', () => {
    expect(deriveActionOffers(baseStatus)).toEqual([
      { action: 'reinstall', mode: 'server' },
      { action: 'doctor', mode: 'terminal', command: 'claude doctor' },
      { action: 'uninstall', mode: 'server' },
    ]);
  });

  test('an outdated CLI offers update first', () => {
    expect(deriveActionOffers({ ...baseStatus, updateAvailable: true, latestVersion: '2.2.0' })[0]).toEqual({ action: 'update', mode: 'server' });
  });

  test('an unknown latest version still offers update', () => {
    expect(deriveActionOffers({ ...baseStatus, latestVersion: null }).map((offer) => offer.action)).toContain('update');
  });

  test('an action with neither a server route nor a command is left out', () => {
    const offers = deriveActionOffers({ ...baseStatus, actions: { ...baseStatus.actions, uninstall: false } });
    expect(offers.map((offer) => offer.action)).not.toContain('uninstall');
  });
});

describe('deriveSignIn', () => {
  test('a signed-in claude logs out on the server and shows the account', () => {
    expect(deriveSignIn(snapshot(), signedIn, { enterpriseMode: false })).toEqual({
      state: 'signed-in', account: 'me@example.com', plan: 'max', login: null, logout: { mode: 'server' },
    });
  });

  test('a signed-out engine logs in through the terminal', () => {
    const view = deriveSignIn(snapshot({ engine: 'codex', commands: { ...baseStatus.commands, login: null } }, 'signed-out', 'codex login'), null, { enterpriseMode: false });
    expect(view.state).toBe('signed-out');
    expect(view.login).toEqual({ command: 'codex login', hint: null });
  });

  test('without a command from the server the default login command is used', () => {
    const view = deriveSignIn(snapshot({ engine: 'codex', commands: { ...baseStatus.commands, login: null } }, 'unknown'), { loggedIn: false, email: null, method: null, plan: null }, { enterpriseMode: false });
    expect(view.login?.command).toBe('codex login --device-auth');
  });

  test('antigravity signs in and out inside agy', () => {
    const agy = { engine: 'antigravity' as const, commands: { ...baseStatus.commands, login: 'agy', logout: null } };
    expect(deriveSignIn(snapshot(agy, 'signed-out'), null, { enterpriseMode: false }).login).toEqual({ command: 'agy', hint: 'agy-login' });
    expect(deriveSignIn(snapshot(agy), null, { enterpriseMode: false }).logout).toEqual({ mode: 'terminal', command: 'agy', hint: 'agy-logout' });
  });

  test('the sign-in read wins over readiness', () => {
    expect(deriveSignIn(snapshot({}, 'ready'), { loggedIn: false, email: null, method: null, plan: null }, { enterpriseMode: false }).state).toBe('signed-out');
  });

  test('enterprise mode offers no login', () => {
    expect(deriveSignIn(snapshot({}, 'signed-out'), null, { enterpriseMode: true }).login).toBeNull();
  });

  test('a missing CLI has no sign-in step', () => {
    expect(deriveSignIn(snapshot({ installed: false }, 'not-installed'), null, { enterpriseMode: false })).toEqual({
      state: 'unknown', account: null, plan: null, login: null, logout: null,
    });
  });
});

describe('deriveCardStatus', () => {
  test('orders working, missing, update, signed-out, ready', () => {
    expect(deriveCardStatus(snapshot({ state: 'installing' }))).toBe('working');
    expect(deriveCardStatus(snapshot({ installed: false }, 'not-installed'))).toBe('not-installed');
    expect(deriveCardStatus(snapshot({ updateAvailable: true }, 'signed-out'))).toBe('update');
    expect(deriveCardStatus(snapshot({}, 'signed-out'))).toBe('signed-out');
    expect(deriveCardStatus(snapshot())).toBe('ready');
    expect(deriveCardStatus(snapshot({}, 'unknown'))).toBeNull();
  });
});

describe('deriveVersion', () => {
  test('reads missing, update and current', () => {
    expect(deriveVersion({ ...baseStatus, installed: false })).toEqual({ kind: 'missing' });
    expect(deriveVersion({ ...baseStatus, updateAvailable: true, latestVersion: '2.2.0' })).toEqual({ kind: 'update', current: '2.1.3', latest: '2.2.0' });
    expect(deriveVersion(baseStatus)).toEqual({ kind: 'current', current: '2.1.3', latest: '2.1.3' });
  });
});

describe('troubleshootingCommands', () => {
  test('lists every known command once, doctor first', () => {
    expect(troubleshootingCommands(snapshot()).map((entry) => entry.id)).toEqual(['doctor', 'update', 'reinstall', 'install', 'login', 'logout']);
  });

  test('a command shared by two steps is listed once', () => {
    const agy = snapshot({ engine: 'antigravity', commands: { install: 'curl x | bash', update: 'agy update', reinstall: null, uninstall: null, doctor: null, login: 'agy', logout: 'agy' } });
    expect(troubleshootingCommands(agy)).toEqual([
      { id: 'update', command: 'agy update' },
      { id: 'install', command: 'curl x | bash' },
      { id: 'login', command: 'agy' },
    ]);
  });
});

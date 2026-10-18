import { describe, expect, test } from 'bun:test';
import { canContinueFromChecklist, canLeaveMobileSetupStep, deriveChecklist, engineLoginCommand, isEngineId, isEngineReady, shouldOpenEngineSetup, type EngineSnapshot } from './engineSetupModel';

const snapshot = (overrides: Partial<EngineSnapshot['status']> = {}, readiness: EngineSnapshot['readiness'] = 'ready', fixCommand: string | null = null): EngineSnapshot => ({
  status: {
    engine: 'codex',
    displayName: 'Codex',
    providerID: 'openai',
    installed: true,
    version: '0.162.1',
    latestVersion: '0.162.1',
    updateAvailable: false,
    canInstall: true,
    installCommand: 'npm install -g @openai/codex',
    state: 'idle',
    lastError: null,
    installSource: 'npm',
    actions: { install: true, update: true, reinstall: true, uninstall: true, doctor: false },
    commands: { install: 'npm install -g @openai/codex', update: 'npm install -g @openai/codex@latest', reinstall: null, uninstall: null, doctor: 'codex doctor', login: 'codex login --device-auth', logout: 'codex logout' },
    currentAction: null,
    rawVersion: null,
    commandPath: null,
    detectionError: null,
    ...overrides,
  },
  readiness,
  fixCommand,
});

describe('deriveChecklist', () => {
  test('a ready, current CLI has every row done', () => {
    expect(deriveChecklist(snapshot(), { enterpriseMode: false })).toEqual({
      cli: { kind: 'done' },
      version: { kind: 'done' },
      login: { kind: 'done' },
    });
  });

  test('a missing npm CLI asks to install and waits on the other rows', () => {
    const list = deriveChecklist(snapshot({ installed: false, version: null }, 'not-installed'), { enterpriseMode: false });
    expect(list.cli).toEqual({ kind: 'action', action: 'install', command: null });
    expect(list.version).toEqual({ kind: 'pending' });
    expect(list.login).toEqual({ kind: 'pending' });
  });

  test('a missing CLI the server cannot install gives its command', () => {
    const base = snapshot().status;
    const list = deriveChecklist(snapshot({
      engine: 'antigravity',
      installed: false,
      actions: { ...base.actions, install: false },
      commands: { ...base.commands, install: 'curl x | bash' },
    }, 'not-installed'), { enterpriseMode: false });
    expect(list.cli).toEqual({ kind: 'action', action: 'install', command: 'curl x | bash' });
  });

  test('an update the server cannot run gives the update command', () => {
    const base = snapshot().status;
    const list = deriveChecklist(snapshot({
      updateAvailable: true,
      actions: { ...base.actions, update: false },
      commands: { ...base.commands, update: 'agy update' },
    }), { enterpriseMode: false });
    expect(list.version).toEqual({ kind: 'action', action: 'update', command: 'agy update' });
  });

  test('an outdated CLI asks to update', () => {
    const list = deriveChecklist(snapshot({ latestVersion: '0.163.0', updateAvailable: true }), { enterpriseMode: false });
    expect(list.version).toEqual({ kind: 'action', action: 'update', command: null });
  });

  test('an install in progress is working on the CLI and version rows', () => {
    const list = deriveChecklist(snapshot({ installed: false, state: 'installing' }, 'not-installed'), { enterpriseMode: false });
    expect(list.cli).toEqual({ kind: 'working' });
    const updating = deriveChecklist(snapshot({ state: 'installing', updateAvailable: true }), { enterpriseMode: false });
    expect(updating.version).toEqual({ kind: 'working' });
  });

  test('a signed-out CLI logs in with the server login command', () => {
    const list = deriveChecklist(snapshot({}, 'signed-out', 'codex login'), { enterpriseMode: false });
    expect(list.login).toEqual({ kind: 'action', action: 'login', command: 'codex login --device-auth' });
  });

  test('without a server login command the readiness fix command is used, then the default', () => {
    const base = snapshot().status;
    const noLogin = { commands: { ...base.commands, login: null } };
    expect(deriveChecklist(snapshot(noLogin, 'signed-out', 'codex login'), { enterpriseMode: false }).login)
      .toEqual({ kind: 'action', action: 'login', command: 'codex login' });
    expect(deriveChecklist(snapshot({ ...noLogin, engine: 'antigravity' }, 'signed-out'), { enterpriseMode: false }).login)
      .toEqual({ kind: 'action', action: 'login', command: 'agy' });
  });

  test('enterprise mode offers no login action', () => {
    const list = deriveChecklist(snapshot({}, 'signed-out', null), { enterpriseMode: true });
    expect(list.login).toEqual({ kind: 'pending' });
  });

  test('an unchecked engine is pending on login', () => {
    expect(deriveChecklist(snapshot({}, 'unknown'), { enterpriseMode: false }).login).toEqual({ kind: 'pending' });
  });
});

describe('readiness gates', () => {
  test('ready means readiness ready', () => {
    expect(isEngineReady(snapshot())).toBe(true);
    expect(isEngineReady(snapshot({}, 'signed-out'))).toBe(false);
  });

  test('continue needs at least one ready engine', () => {
    expect(canContinueFromChecklist([])).toBe(false);
    expect(canContinueFromChecklist([snapshot({}, 'signed-out')])).toBe(false);
    expect(canContinueFromChecklist([snapshot({}, 'signed-out'), snapshot()])).toBe(true);
  });
});

describe('shouldOpenEngineSetup', () => {
  const ready = snapshot();
  const signedOut = snapshot({}, 'signed-out');
  const missing = snapshot({ engine: 'claude', installed: false, version: null }, 'not-installed');
  const unknown = snapshot({}, 'unknown');

  test('opens on a fresh server where no engine is ready', () => {
    expect(shouldOpenEngineSetup([missing, signedOut], { setupCompleted: false })).toBe(true);
    expect(shouldOpenEngineSetup([missing, signedOut], { setupCompleted: true })).toBe(true);
  });

  test('never blocks a server with a ready engine', () => {
    expect(shouldOpenEngineSetup([ready, missing], { setupCompleted: false })).toBe(false);
    expect(shouldOpenEngineSetup([ready], { setupCompleted: true })).toBe(false);
  });

  test('opens for an unfinished setup while readiness is still unknown, but not after it was completed', () => {
    expect(shouldOpenEngineSetup([unknown], { setupCompleted: false })).toBe(true);
    expect(shouldOpenEngineSetup([unknown, signedOut], { setupCompleted: true })).toBe(false);
  });

  test('stays closed when the server reported no engines', () => {
    expect(shouldOpenEngineSetup([], { setupCompleted: false })).toBe(false);
  });
});

describe('mobile setup steps', () => {
  test('each step moves on once its work is done', () => {
    const missing = snapshot({ installed: false, version: null }, 'not-installed');
    const signedOut = snapshot({}, 'signed-out');
    expect(canLeaveMobileSetupStep('choose', { selected: [], hasModel: false })).toBe(false);
    expect(canLeaveMobileSetupStep('choose', { selected: [missing], hasModel: false })).toBe(true);
    expect(canLeaveMobileSetupStep('install', { selected: [missing], hasModel: false })).toBe(false);
    expect(canLeaveMobileSetupStep('install', { selected: [missing, signedOut], hasModel: false })).toBe(true);
    expect(canLeaveMobileSetupStep('signIn', { selected: [signedOut], hasModel: false })).toBe(false);
    expect(canLeaveMobileSetupStep('signIn', { selected: [signedOut, snapshot()], hasModel: false })).toBe(true);
    expect(canLeaveMobileSetupStep('model', { selected: [snapshot()], hasModel: false })).toBe(false);
    expect(canLeaveMobileSetupStep('model', { selected: [snapshot()], hasModel: true })).toBe(true);
  });
});

describe('engine sign-in command', () => {
  test('uses the server command when known and the CLI default otherwise', () => {
    expect(engineLoginCommand('codex', snapshot())).toBe('codex login --device-auth');
    expect(engineLoginCommand('claude', undefined)).toBe('claude auth login');
    expect(isEngineId('antigravity')).toBe(true);
    expect(isEngineId('opencode')).toBe(false);
    expect(isEngineId('toString')).toBe(false);
  });
});

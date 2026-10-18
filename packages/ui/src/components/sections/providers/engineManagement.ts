import {
  loginCommandFor,
  type EngineActionId,
  type EngineAuth,
  type EngineCommandId,
  type EngineSnapshot,
  type EngineStatus,
} from '@/components/setup-wizard/engineSetupModel';

export type ActionOffer =
  | { action: EngineActionId; mode: 'server' }
  | { action: EngineActionId; mode: 'terminal'; command: string };

export type TerminalHint = 'agy-login' | 'agy-logout' | null;

export type TerminalStep = { command: string; hint: TerminalHint };

export type SignInView = {
  state: 'signed-in' | 'signed-out' | 'unknown';
  account: string | null;
  plan: string | null;
  login: TerminalStep | null;
  logout: { mode: 'server' } | ({ mode: 'terminal' } & TerminalStep) | null;
};

export type EngineCardStatus = 'working' | 'not-installed' | 'update' | 'signed-out' | 'ready' | null;

export type VersionView =
  | { kind: 'missing' }
  | { kind: 'update'; current: string | null; latest: string }
  | { kind: 'current'; current: string | null; latest: string | null };

export type CommandEntry = { id: EngineCommandId; command: string };

const AGY_COMMAND = 'agy';

const TROUBLESHOOTING_ORDER: readonly EngineCommandId[] = ['doctor', 'update', 'reinstall', 'install', 'login', 'logout', 'uninstall'];

export const isEngineBusy = (status: EngineStatus): boolean => status.state === 'installing';

const offersUpdate = (status: EngineStatus): boolean => status.updateAvailable || status.latestVersion === null;

const offeredActions = (status: EngineStatus): EngineActionId[] => {
  if (!status.installed) return ['install'];
  return [...(offersUpdate(status) ? ['update' as const] : []), 'reinstall', 'doctor', 'uninstall'];
};

export const deriveActionOffers = (status: EngineStatus): ActionOffer[] => offeredActions(status).flatMap((action): ActionOffer[] => {
  if (status.actions[action]) return [{ action, mode: 'server' }];
  const command = status.commands[action];
  return command ? [{ action, mode: 'terminal', command }] : [];
});

const signInState = (snapshot: EngineSnapshot, auth: EngineAuth | null): SignInView['state'] => {
  if (auth) return auth.loggedIn ? 'signed-in' : 'signed-out';
  if (snapshot.readiness === 'ready') return 'signed-in';
  if (snapshot.readiness === 'signed-out') return 'signed-out';
  return 'unknown';
};

const loginStep = (snapshot: EngineSnapshot): TerminalStep => ({
  command: loginCommandFor(snapshot),
  hint: snapshot.status.engine === 'antigravity' ? 'agy-login' : null,
});

const logoutStep = (status: EngineStatus): SignInView['logout'] => {
  if (status.engine !== 'antigravity') return { mode: 'server' };
  return { mode: 'terminal', command: status.commands.logout ?? AGY_COMMAND, hint: 'agy-logout' };
};

export const deriveSignIn = (
  snapshot: EngineSnapshot,
  auth: EngineAuth | null,
  { enterpriseMode }: { enterpriseMode: boolean },
): SignInView => {
  const { status } = snapshot;
  if (!status.installed) return { state: 'unknown', account: null, plan: null, login: null, logout: null };
  const state = signInState(snapshot, auth);
  return {
    state,
    account: auth?.email ?? auth?.method ?? null,
    plan: auth?.plan ?? null,
    login: state !== 'signed-in' && !enterpriseMode ? loginStep(snapshot) : null,
    logout: state === 'signed-in' ? logoutStep(status) : null,
  };
};

export const deriveCardStatus = (snapshot: EngineSnapshot): EngineCardStatus => {
  const { status } = snapshot;
  if (isEngineBusy(status)) return 'working';
  if (!status.installed) return 'not-installed';
  if (status.updateAvailable) return 'update';
  if (snapshot.readiness === 'signed-out') return 'signed-out';
  if (snapshot.readiness === 'ready') return 'ready';
  return null;
};

export const deriveVersion = (status: EngineStatus): VersionView => {
  if (!status.installed) return { kind: 'missing' };
  if (status.updateAvailable && status.latestVersion) return { kind: 'update', current: status.version, latest: status.latestVersion };
  return { kind: 'current', current: status.version, latest: status.latestVersion };
};

export const troubleshootingCommands = (snapshot: EngineSnapshot): CommandEntry[] => {
  const seen = new Set<string>();
  const commands: Record<EngineCommandId, string | null> = { ...snapshot.status.commands, login: loginStep(snapshot).command };
  return TROUBLESHOOTING_ORDER.flatMap((id): CommandEntry[] => {
    const command = commands[id];
    if (!command || seen.has(command)) return [];
    seen.add(command);
    return [{ id, command }];
  });
};

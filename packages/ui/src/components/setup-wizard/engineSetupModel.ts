export type EngineId = 'claude' | 'codex' | 'antigravity';

export const ENGINE_ACTION_IDS = ['install', 'update', 'reinstall', 'uninstall', 'doctor'] as const;

export type EngineActionId = (typeof ENGINE_ACTION_IDS)[number];

export type EngineCommandId = EngineActionId | 'login' | 'logout';

export type InstallSource = 'npm' | 'native' | 'brew' | 'unknown';

export type EngineStatus = {
  engine: EngineId;
  displayName: string;
  providerID: string;
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  canInstall: boolean;
  installCommand: string;
  state: 'idle' | 'installing' | 'completed' | 'failed';
  lastError: string | null;
  installSource: InstallSource;
  actions: Record<EngineActionId, boolean>;
  commands: Record<EngineCommandId, string | null>;
  currentAction: EngineActionId | null;
  rawVersion: string | null;
  commandPath: string | null;
  detectionError: string | null;
};

export type EngineAuth = { loggedIn: boolean; email: string | null; method: string | null; plan: string | null };

export type Readiness = 'unknown' | 'ready' | 'not-installed' | 'signed-out';

export type EngineSnapshot = { status: EngineStatus; readiness: Readiness; fixCommand: string | null };

export type RowState =
  | { kind: 'done' }
  | { kind: 'working' }
  | { kind: 'pending' }
  | { kind: 'action'; action: 'install' | 'update'; command: string | null }
  | { kind: 'action'; action: 'login'; command: string };

export type EngineChecklist = { cli: RowState; version: RowState; login: RowState };

const DEFAULT_LOGIN_COMMAND: Record<EngineId, string> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
  antigravity: 'agy',
};

export const loginCommandFor = ({ status, fixCommand }: EngineSnapshot): string =>
  status.commands.login ?? fixCommand ?? DEFAULT_LOGIN_COMMAND[status.engine];

export const engineLoginCommand = (engine: EngineId, snapshot: EngineSnapshot | undefined): string =>
  snapshot ? loginCommandFor(snapshot) : DEFAULT_LOGIN_COMMAND[engine];

export const isEngineId = (value: unknown): value is EngineId => typeof value === 'string' && Object.hasOwn(DEFAULT_LOGIN_COMMAND, value);

const DONE: RowState = { kind: 'done' };
const WORKING: RowState = { kind: 'working' };
const PENDING: RowState = { kind: 'pending' };

const cliRow = ({ status }: EngineSnapshot): RowState => {
  if (status.installed) return DONE;
  if (status.state === 'installing') return WORKING;
  return { kind: 'action', action: 'install', command: status.actions.install ? null : status.commands.install ?? status.installCommand };
};

const versionRow = ({ status }: EngineSnapshot): RowState => {
  if (!status.installed) return PENDING;
  if (!status.updateAvailable) return DONE;
  if (status.state === 'installing') return WORKING;
  return { kind: 'action', action: 'update', command: status.actions.update ? null : status.commands.update ?? status.installCommand };
};

const loginRow = (snapshot: EngineSnapshot, enterpriseMode: boolean): RowState => {
  if (snapshot.readiness === 'ready') return DONE;
  if (snapshot.readiness !== 'signed-out' || enterpriseMode) return PENDING;
  return { kind: 'action', action: 'login', command: loginCommandFor(snapshot) };
};

export const deriveChecklist = (snapshot: EngineSnapshot, { enterpriseMode }: { enterpriseMode: boolean }): EngineChecklist => ({
  cli: cliRow(snapshot),
  version: versionRow(snapshot),
  login: loginRow(snapshot, enterpriseMode),
});

export const isEngineReady = (snapshot: EngineSnapshot): boolean => snapshot.readiness === 'ready';

export const canContinueFromChecklist = (snapshots: EngineSnapshot[]): boolean => snapshots.some(isEngineReady);

const UNREADY: ReadonlySet<Readiness> = new Set(['not-installed', 'signed-out']);

export const shouldOpenEngineSetup = (snapshots: readonly EngineSnapshot[], { setupCompleted }: { setupCompleted: boolean }): boolean => {
  if (snapshots.length === 0 || snapshots.some(isEngineReady)) return false;
  return !setupCompleted || snapshots.every((snapshot) => UNREADY.has(snapshot.readiness));
};

export const MOBILE_SETUP_STEPS = ['choose', 'install', 'signIn', 'model', 'done'] as const;

export type MobileSetupStep = (typeof MOBILE_SETUP_STEPS)[number];

export const canLeaveMobileSetupStep = (
  step: MobileSetupStep,
  { selected, hasModel }: { selected: readonly EngineSnapshot[]; hasModel: boolean },
): boolean => {
  if (step === 'choose') return selected.length > 0;
  if (step === 'install') return selected.some((snapshot) => snapshot.status.installed);
  if (step === 'signIn') return canContinueFromChecklist([...selected]);
  if (step === 'model') return hasModel;
  return true;
};

export type EngineId = 'claude' | 'codex' | 'antigravity';

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
};

export type Readiness = 'unknown' | 'ready' | 'not-installed' | 'signed-out';

export type EngineSnapshot = { status: EngineStatus; readiness: Readiness; fixCommand: string | null };

export type RowState =
  | { kind: 'done' }
  | { kind: 'working' }
  | { kind: 'pending' }
  | { kind: 'action'; action: 'install' | 'update' | 'login'; command: string | null };

export type EngineChecklist = { cli: RowState; version: RowState; login: RowState };

const DONE: RowState = { kind: 'done' };
const WORKING: RowState = { kind: 'working' };
const PENDING: RowState = { kind: 'pending' };

const cliRow = ({ status }: EngineSnapshot): RowState => {
  if (status.installed) return DONE;
  if (status.state === 'installing') return WORKING;
  return { kind: 'action', action: 'install', command: status.canInstall ? null : status.installCommand };
};

const versionRow = ({ status }: EngineSnapshot): RowState => {
  if (!status.installed) return PENDING;
  if (!status.updateAvailable) return DONE;
  if (status.state === 'installing') return WORKING;
  return { kind: 'action', action: 'update', command: status.canInstall ? null : status.installCommand };
};

const loginRow = (snapshot: EngineSnapshot, enterpriseMode: boolean): RowState => {
  if (snapshot.readiness === 'ready') return DONE;
  if (snapshot.readiness !== 'signed-out' || enterpriseMode) return PENDING;
  return { kind: 'action', action: 'login', command: snapshot.fixCommand };
};

export const deriveChecklist = (snapshot: EngineSnapshot, { enterpriseMode }: { enterpriseMode: boolean }): EngineChecklist => ({
  cli: cliRow(snapshot),
  version: versionRow(snapshot),
  login: loginRow(snapshot, enterpriseMode),
});

export const isEngineReady = (snapshot: EngineSnapshot): boolean => snapshot.readiness === 'ready';

export const canContinueFromChecklist = (snapshots: EngineSnapshot[]): boolean => snapshots.some(isEngineReady);

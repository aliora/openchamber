import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  ENGINE_ACTION_IDS,
  type EngineActionId,
  type EngineAuth,
  type EngineId,
  type EngineStatus,
  type InstallSource,
  type Readiness,
} from './engineSetupModel';

const engineIdSchema = z.enum(['claude', 'codex', 'antigravity']);

const nullableString = z.string().nullable().catch(null);
const optionalCommand = z.string().nullable().optional().catch(undefined);
const optionalFlag = z.boolean().optional().catch(undefined);

const engineStatusSchema = z.object({
  engine: engineIdSchema,
  displayName: z.string(),
  providerID: z.string(),
  installed: z.boolean(),
  version: nullableString,
  latestVersion: nullableString,
  updateAvailable: z.boolean().catch(false),
  canInstall: z.boolean(),
  installCommand: z.string(),
  state: z.string().catch('idle'),
  lastError: nullableString,
  installSource: z.enum(['npm', 'native', 'brew', 'unknown']).optional().catch(undefined),
  packageManager: z.string().nullable().optional().catch(undefined),
  actions: z.object({
    install: optionalFlag,
    update: optionalFlag,
    reinstall: optionalFlag,
    uninstall: optionalFlag,
    doctor: optionalFlag,
  }).optional().catch(undefined),
  commands: z.object({
    install: optionalCommand,
    update: optionalCommand,
    reinstall: optionalCommand,
    uninstall: optionalCommand,
    doctor: optionalCommand,
    login: optionalCommand,
    logout: optionalCommand,
  }).optional().catch(undefined),
  action: z.enum(ENGINE_ACTION_IDS).nullable().optional().catch(undefined),
  rawVersion: z.string().nullable().optional().catch(undefined),
  command: z.string().nullable().optional().catch(undefined),
  detection: z.object({
    error: z.string().nullable().optional().catch(undefined),
    stderr: z.string().nullable().optional().catch(undefined),
  }).nullable().optional().catch(undefined),
});

type RawEngineStatus = z.infer<typeof engineStatusSchema>;

const BUSY_STATES = new Set(['installing', 'running']);

const toState = (state: string): EngineStatus['state'] => {
  if (BUSY_STATES.has(state)) return 'installing';
  if (state === 'completed' || state === 'failed') return state;
  return 'idle';
};

const toInstallSource = (raw: RawEngineStatus): InstallSource => {
  if (raw.installSource) return raw.installSource;
  return raw.installed && raw.packageManager === 'npm' ? 'npm' : 'unknown';
};

const blank = (value: string | null | undefined): string | null => (value && value.trim() ? value : null);

export const normalizeEngineStatus = (raw: RawEngineStatus): EngineStatus => {
  const legacyNpmUpdate = raw.canInstall ? raw.installCommand : null;
  return {
    engine: raw.engine,
    displayName: raw.displayName,
    providerID: raw.providerID,
    installed: raw.installed,
    version: raw.version,
    latestVersion: raw.latestVersion,
    updateAvailable: raw.updateAvailable,
    canInstall: raw.canInstall,
    installCommand: raw.installCommand,
    state: toState(raw.state),
    lastError: raw.lastError,
    installSource: toInstallSource(raw),
    actions: {
      install: raw.actions?.install ?? raw.canInstall,
      update: raw.actions?.update ?? raw.canInstall,
      reinstall: raw.actions?.reinstall ?? false,
      uninstall: raw.actions?.uninstall ?? false,
      doctor: raw.actions?.doctor ?? false,
    },
    commands: {
      install: blank(raw.commands?.install) ?? blank(raw.installCommand),
      update: raw.commands ? blank(raw.commands.update) : legacyNpmUpdate,
      reinstall: blank(raw.commands?.reinstall),
      uninstall: blank(raw.commands?.uninstall),
      doctor: blank(raw.commands?.doctor),
      login: blank(raw.commands?.login),
      logout: blank(raw.commands?.logout),
    },
    currentAction: raw.action ?? null,
    rawVersion: blank(raw.rawVersion),
    commandPath: blank(raw.command),
    detectionError: blank(raw.detection?.stderr) ?? blank(raw.detection?.error),
  };
};

const enginesResponseSchema = z.object({ data: z.array(engineStatusSchema.nullable().catch(null)) });

const readinessResponseSchema = z.object({
  data: z.array(z.object({
    engine: engineIdSchema,
    state: z.enum(['unknown', 'ready', 'not-installed', 'signed-out']).catch('unknown'),
    fixCommand: z.string().nullable().catch(null),
  }).nullable().catch(null)),
});

const authStatusSchema = z.object({
  loggedIn: z.boolean().catch(false),
  email: z.string().nullable().optional().catch(undefined),
  authMethod: z.string().nullable().optional().catch(undefined),
  subscriptionType: z.string().nullable().optional().catch(undefined),
});

const errorBodySchema = z.object({
  error: z.string().optional().catch(undefined),
  command: z.string().nullable().optional().catch(undefined),
  installCommand: z.string().nullable().optional().catch(undefined),
}).catch({});

export const parseEngineStatuses = (body: unknown): EngineStatus[] => {
  const { data } = enginesResponseSchema.parse(body);
  return data.flatMap((entry) => (entry ? [normalizeEngineStatus(entry)] : []));
};

export const fetchEngineStatuses = async (): Promise<EngineStatus[]> => {
  const response = await runtimeFetch('/api/engines');
  if (!response.ok) throw new Error(`Engine list request failed (${response.status})`);
  return parseEngineStatuses(await response.json());
};

export const fetchReadinessByEngine = async (): Promise<Map<EngineId, { state: Readiness; fixCommand: string | null }>> => {
  const response = await runtimeFetch('/api/engines/readiness');
  if (!response.ok) throw new Error(`Engine readiness request failed (${response.status})`);
  const { data } = readinessResponseSchema.parse(await response.json());
  return new Map(data.flatMap((entry) => (entry ? [[entry.engine, { state: entry.state, fixCommand: entry.fixCommand }] as const] : [])));
};

export const fetchEngineAuth = async (engine: EngineId): Promise<EngineAuth> => {
  const response = await runtimeFetch(`/api/engines/${engine}/auth/status`);
  if (!response.ok) throw new Error(`Sign-in status request failed (${response.status})`);
  const body = authStatusSchema.parse(await response.json());
  return {
    loggedIn: body.loggedIn,
    email: blank(body.email),
    method: blank(body.authMethod),
    plan: body.subscriptionType && body.subscriptionType !== 'unknown' ? body.subscriptionType : null,
  };
};

export type EngineActionResult =
  | { kind: 'started' }
  | { kind: 'command'; command: string; message: string | null }
  | { kind: 'busy' }
  | { kind: 'failed'; message: string };

const LEGACY_INSTALL_ACTIONS = new Set<EngineActionId>(['install', 'update']);

const postAction = (engine: EngineId, action: EngineActionId, removeConfig: boolean): Promise<Response> => runtimeFetch(
  `/api/engines/${engine}/actions/${action}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'uninstall' ? { removeConfig } : {}),
  },
);

const toActionResult = async (response: Response): Promise<EngineActionResult> => {
  if (response.ok) return { kind: 'started' };
  const body = errorBodySchema.parse(await response.json().catch(() => ({})));
  if (response.status === 409) return { kind: 'busy' };
  const command = blank(body.command) ?? blank(body.installCommand);
  if (response.status === 400 && command) return { kind: 'command', command, message: body.error ?? null };
  return { kind: 'failed', message: body.error ?? `Request failed (${response.status})` };
};

export const runEngineAction = async (
  engine: EngineId,
  action: EngineActionId,
  { removeConfig = false }: { removeConfig?: boolean } = {},
): Promise<EngineActionResult> => {
  const response = await postAction(engine, action, removeConfig);
  if (response.status === 404 && LEGACY_INSTALL_ACTIONS.has(action)) {
    return toActionResult(await runtimeFetch(`/api/engines/${engine}/install`, { method: 'POST' }));
  }
  return toActionResult(response);
};

export const logoutEngine = async (engine: EngineId): Promise<{ ok: boolean; message: string | null }> => {
  const response = await runtimeFetch(`/api/engines/${engine}/auth/logout`, { method: 'POST' });
  const body = errorBodySchema.parse(await response.json().catch(() => ({})));
  return { ok: response.ok, message: response.ok ? null : body.error ?? `Request failed (${response.status})` };
};

const modelRefreshSchema = z.object({
  models: z.array(z.unknown()).catch([]),
  error: z.string().nullable().optional().catch(undefined),
}).catch({ models: [] });

export const refreshEngineModels = async (engine: EngineId): Promise<{ ok: boolean; count: number; message: string | null }> => {
  const response = await runtimeFetch(`/api/engines/${engine}/models/refresh`, { method: 'POST' });
  const body = modelRefreshSchema.parse(await response.json().catch(() => ({})));
  return {
    ok: response.ok,
    count: body.models.length,
    message: response.ok ? null : body.error ?? `Request failed (${response.status})`,
  };
};

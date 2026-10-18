/**
 * What the composer offers for each engine's sessions on the connected server
 * (`GET /api/engines/controls`, *Catalog* in
 * `packages/web/server/lib/engine/DOCUMENTATION.md`): its permission modes,
 * each with the message keys of its label and description, and its default
 * effort. Also each open session's engine and permission mode, read from its
 * stored record, and the change of a session's mode (`PATCH /api/session/:id`).
 *
 * A server without engines answers the controls with 404: its sessions run on
 * OpenCode, and OpenChamber's own permission auto-accept (the shield) is the
 * permission control there. Nothing here is persisted; a runtime switch drops
 * it all, with a generation check against reads still in flight.
 */
import { z } from 'zod';
import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';

const permissionModeSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  descriptionKey: z.string().min(1),
  dangerous: z.boolean().catch(false),
  appliesLive: z.boolean().catch(false),
});

const engineControlsSchema = z.object({
  engine: z.string().min(1),
  providerID: z.string().min(1),
  defaultPermissionMode: z.string().min(1),
  // One malformed mode is dropped; the engine keeps the others.
  permissionModes: z.array(permissionModeSchema.nullable().catch(null))
    .transform((modes) => modes.flatMap((mode) => (mode ? [mode] : []))),
  defaultEffort: z.string().min(1).nullable().catch(null),
}).refine((engine) => engine.permissionModes.some((mode) => mode.id === engine.defaultPermissionMode));

// One malformed engine is dropped; the other engines still count.
const controlsResponseSchema = z.object({
  data: z.array(engineControlsSchema.nullable().catch(null)),
  default: z.string().min(1),
});

// The stored record of `GET /api/sessions/:id`. A record from before engines
// names neither field: it runs on the default engine in its default mode.
const sessionRecordSchema = z.object({
  engine: z.string().min(1).nullish().catch(null),
  permissionMode: z.string().min(1).nullish().catch(null),
});

// The body of a refused change: `message` on the singular route, `error` on the plural one.
const errorBodySchema = z.object({
  message: z.string().min(1).optional().catch(undefined),
  error: z.string().min(1).optional().catch(undefined),
});

export type EnginePermissionModeOption = z.infer<typeof permissionModeSchema>;
export type EngineControls = z.infer<typeof engineControlsSchema>;

export interface EngineControlsCatalog {
  engines: readonly EngineControls[];
  defaultEngine: string;
}

/** One session's engine and permission mode as its stored record has them. */
interface SessionEngineSettings {
  engine: string;
  permissionMode: string;
}

/**
 * The controls, or null when this server has no engines (404). Throws on any
 * other failure, so a failed read never looks like a server without engines.
 */
export const fetchEngineControls = async (): Promise<EngineControlsCatalog | null> => {
  const response = await runtimeFetch('/api/engines/controls');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Engine controls request failed (${response.status})`);
  const parsed = controlsResponseSchema.parse(await response.json());
  return {
    engines: parsed.data.flatMap((engine) => (engine ? [engine] : [])),
    defaultEngine: parsed.default,
  };
};

/** The session's stored engine and mode; a field the record lacks resolves through the catalog. */
const fetchSessionRecord = async (sessionId: string): Promise<z.infer<typeof sessionRecordSchema>> => {
  const response = await runtimeFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Session record request failed (${response.status})`);
  return sessionRecordSchema.parse(await response.json());
};

/** Error a refused permission mode change rejects with; `reason` is the server's message when it sent one. */
export class PermissionModeChangeError extends Error {
  readonly reason: string | null;

  constructor(status: number, reason: string | null) {
    super(reason ?? `Permission mode change failed (${status})`);
    this.reason = reason;
  }
}

const patchSessionPermissionMode = async (sessionId: string, permissionMode: string): Promise<void> => {
  const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissionMode }),
  });
  if (response.ok) return;
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  const reason = body.success ? body.data.message ?? body.data.error ?? null : null;
  throw new PermissionModeChangeError(response.status, reason);
};

/** Injected in tests; the defaults talk to the connected server. */
export interface EngineControlsTransport {
  fetchControls: () => Promise<EngineControlsCatalog | null>;
  fetchSession: (sessionId: string) => Promise<z.infer<typeof sessionRecordSchema>>;
  patchPermissionMode: (sessionId: string, permissionMode: string) => Promise<void>;
}

const defaultTransport: EngineControlsTransport = {
  fetchControls: fetchEngineControls,
  fetchSession: fetchSessionRecord,
  patchPermissionMode: patchSessionPermissionMode,
};

/**
 * `ready`: the server runs engines and `catalog` lists them. `unsupported`: a
 * server without engines. `failed`: the last read failed; the next caller
 * retries. A session is in `sessions` once its record was read.
 */
type ControlsStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed';

interface EngineControlsState {
  status: ControlsStatus;
  catalog: EngineControlsCatalog | null;
  sessions: ReadonlyMap<string, SessionEngineSettings>;
  /** Reads the controls unless a read is running or they are known. */
  load: (transport?: EngineControlsTransport) => Promise<void>;
  /** Reads one session's engine and mode, again on every call: another client may have changed them. */
  loadSession: (sessionId: string, transport?: EngineControlsTransport) => Promise<void>;
  /**
   * Shows `permissionMode` at once and stores it on the server. A refused or
   * failed change puts back what was shown before, unless a newer change
   * replaced it meanwhile, and rejects.
   */
  setSessionPermissionMode: (sessionId: string, permissionMode: string, transport?: EngineControlsTransport) => Promise<void>;
  resetForRuntimeSwitch: () => void;
}

/** Bumped on every runtime switch; an answer from an older generation is dropped. */
let generation = 0;
/** The newest change per session, so an older change's rollback cannot undo it. */
const changeSequence = new Map<string, number>();
let nextChange = 0;

const withSession = (
  sessions: ReadonlyMap<string, SessionEngineSettings>,
  sessionId: string,
  settings: SessionEngineSettings,
): ReadonlyMap<string, SessionEngineSettings> => {
  const next = new Map(sessions);
  next.set(sessionId, settings);
  return next;
};

export const useEngineControlsStore = create<EngineControlsState>()((set, get) => ({
  status: 'idle',
  catalog: null,
  sessions: new Map(),

  load: async (transport = defaultTransport) => {
    const { status } = get();
    if (status === 'loading' || status === 'ready' || status === 'unsupported') return;
    const started = generation;
    set({ status: 'loading' });
    try {
      const catalog = await transport.fetchControls();
      if (started !== generation) return;
      set(catalog ? { status: 'ready', catalog } : { status: 'unsupported', catalog: null });
    } catch (error) {
      if (started !== generation) return;
      console.warn('[engines] controls read failed:', error instanceof Error ? error.message : error);
      set({ status: 'failed' });
    }
  },

  loadSession: async (sessionId, transport = defaultTransport) => {
    const started = generation;
    const sequence = changeSequence.get(sessionId);
    try {
      const record = await transport.fetchSession(sessionId);
      // A change made while the read ran is newer than what the read saw.
      if (started !== generation || changeSequence.get(sessionId) !== sequence) return;
      const catalog = get().catalog;
      const engine = record.engine ?? catalog?.defaultEngine;
      if (!engine) return;
      const controls = catalog?.engines.find((candidate) => candidate.engine === engine);
      const permissionMode = record.permissionMode ?? controls?.defaultPermissionMode;
      if (!permissionMode) return;
      set((state) => ({ sessions: withSession(state.sessions, sessionId, { engine, permissionMode }) }));
    } catch (error) {
      if (started !== generation) return;
      console.warn('[engines] session settings read failed:', error instanceof Error ? error.message : error);
    }
  },

  setSessionPermissionMode: async (sessionId, permissionMode, transport = defaultTransport) => {
    const started = generation;
    const previous = get().sessions.get(sessionId);
    const sequence = ++nextChange;
    changeSequence.set(sessionId, sequence);
    if (previous) {
      set((state) => ({ sessions: withSession(state.sessions, sessionId, { ...previous, permissionMode }) }));
    }
    try {
      await transport.patchPermissionMode(sessionId, permissionMode);
    } catch (error) {
      if (started === generation && changeSequence.get(sessionId) === sequence && previous) {
        set((state) => ({ sessions: withSession(state.sessions, sessionId, previous) }));
      }
      throw error;
    }
  },

  resetForRuntimeSwitch: () => {
    generation += 1;
    changeSequence.clear();
    set({ status: 'idle', catalog: null, sessions: new Map() });
  },
}));

/** The engine whose models carry `providerId`, when the server runs engines. */
export const findEngineForProvider = (
  catalog: EngineControlsCatalog | null,
  providerId: string | null | undefined,
): EngineControls | null => catalog?.engines.find((engine) => engine.providerID === providerId) ?? null;

/**
 * The mode a chat runs in on `engine` after `picked` was chosen on its own
 * engine, as the server carries a mode when a chat moves to another engine:
 * the picked mode when `engine` has it, `engine`'s full permission mode for a
 * full permission pick, else `engine`'s default.
 */
export const carriedPermissionMode = (
  catalog: EngineControlsCatalog,
  picked: { engine: string; mode: string } | undefined,
  engine: EngineControls,
): string => {
  if (!picked) return engine.defaultPermissionMode;
  if (engine.permissionModes.some((mode) => mode.id === picked.mode)) return picked.mode;
  const source = catalog.engines.find((candidate) => candidate.engine === picked.engine);
  const pickedFull = source?.permissionModes.some((mode) => mode.id === picked.mode && mode.dangerous) ?? false;
  const full = engine.permissionModes.find((mode) => mode.dangerous);
  return pickedFull && full ? full.id : engine.defaultPermissionMode;
};

/**
 * The effort a model of `providerId` runs at when none was picked, when it is
 * one of the model's `levels`; null on a server without engines. Effort menus
 * mark that level instead of offering a separate "Default".
 */
export const engineDefaultEffortFor = (
  catalog: EngineControlsCatalog | null,
  providerId: string | null | undefined,
  levels: readonly string[],
): string | null => {
  const effort = findEngineForProvider(catalog, providerId)?.defaultEffort ?? null;
  return effort !== null && levels.includes(effort) ? effort : null;
};

/**
 * Whether OpenChamber's own permission auto-accept applies: only on a server
 * without engines. Until the controls are read it does not, so a request is
 * shown to the user rather than held for an answer that may never come.
 */
export const isOpenChamberAutoAcceptActive = (): boolean => useEngineControlsStore.getState().status === 'unsupported';

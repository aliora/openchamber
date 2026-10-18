import React from 'react';
import { create } from 'zustand';
import {
  fetchEngineAuth,
  fetchEngineStatuses,
  fetchReadinessByEngine,
  logoutEngine,
  runEngineAction,
} from './engineSetupApi';
import type { EngineActionId, EngineAuth, EngineId, EngineSnapshot, EngineStatus, Readiness } from './engineSetupModel';

type Loaders = {
  statuses: () => Promise<EngineStatus[]>;
  readiness: () => Promise<Map<EngineId, { state: Readiness; fixCommand: string | null }>>;
};

const defaultLoaders: Loaders = { statuses: fetchEngineStatuses, readiness: fetchReadinessByEngine };

export type EngineActionNotice =
  | { action: EngineActionId; kind: 'command'; command: string }
  | { action: EngineActionId; kind: 'busy' }
  | { action: EngineActionId; kind: 'failed'; message: string };

export type EngineAuthEntry = { kind: 'loaded'; auth: EngineAuth } | { kind: 'failed'; message: string };

type EngineSetupState = {
  snapshots: Map<EngineId, EngineSnapshot>;
  loaded: boolean;
  error: string | null;
  auth: Map<EngineId, EngineAuthEntry>;
  actionNotice: Map<EngineId, EngineActionNotice>;
  logoutMessage: Map<EngineId, string>;
  refresh: (loaders?: Loaders) => Promise<void>;
  refreshAuth: (engine: EngineId) => Promise<void>;
  runAction: (engine: EngineId, action: EngineActionId, options?: { removeConfig?: boolean }) => Promise<void>;
  logout: (engine: EngineId) => Promise<void>;
};

const withEntry = <V>(map: Map<EngineId, V>, engine: EngineId, value: V | null): Map<EngineId, V> => {
  const next = new Map(map);
  if (value === null) next.delete(engine);
  else next.set(engine, value);
  return next;
};

let refreshGeneration = 0;

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const useEngineSetupStore = create<EngineSetupState>()((set, get) => ({
  snapshots: new Map(),
  loaded: false,
  error: null,
  auth: new Map(),
  actionNotice: new Map(),
  logoutMessage: new Map(),

  refresh: async (loaders = defaultLoaders) => {
    const generation = ++refreshGeneration;
    try {
      const [statuses, readiness] = await Promise.all([loaders.statuses(), loaders.readiness()]);
      if (generation !== refreshGeneration) return;
      const snapshots = new Map<EngineId, EngineSnapshot>();
      for (const status of statuses) {
        const entry = readiness.get(status.engine);
        snapshots.set(status.engine, { status, readiness: entry?.state ?? 'unknown', fixCommand: entry?.fixCommand ?? null });
      }
      set({ snapshots, loaded: true, error: null });
    } catch (error) {
      if (generation !== refreshGeneration) return;
      set({ error: toMessage(error) });
    }
  },

  refreshAuth: async (engine) => {
    let entry: EngineAuthEntry;
    try {
      entry = { kind: 'loaded', auth: await fetchEngineAuth(engine) };
    } catch (error) {
      entry = { kind: 'failed', message: toMessage(error) };
    }
    set({ auth: withEntry(get().auth, engine, entry) });
  },

  runAction: async (engine, action, options) => {
    let notice: EngineActionNotice | null;
    try {
      const result = await runEngineAction(engine, action, options);
      if (result.kind === 'started') notice = null;
      else if (result.kind === 'command') notice = { action, kind: 'command', command: result.command };
      else if (result.kind === 'busy') notice = { action, kind: 'busy' };
      else notice = { action, kind: 'failed', message: result.message };
    } catch (error) {
      notice = { action, kind: 'failed', message: toMessage(error) };
    }
    set({ actionNotice: withEntry(get().actionNotice, engine, notice) });
    await get().refresh();
  },

  logout: async (engine) => {
    let message: string | null;
    try {
      message = (await logoutEngine(engine)).message;
    } catch (error) {
      message = toMessage(error);
    }
    set({ logoutMessage: withEntry(get().logoutMessage, engine, message) });
    await Promise.all([get().refreshAuth(engine), get().refresh()]);
  },
}));

export const useEngineSetupPolling = (enabled: boolean, intervalMs = 5000): void => {
  const refresh = useEngineSetupStore((state) => state.refresh);
  React.useEffect(() => {
    if (!enabled) return undefined;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refresh();
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh]);
};

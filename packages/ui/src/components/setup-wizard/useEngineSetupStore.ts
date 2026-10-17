import React from 'react';
import { create } from 'zustand';
import { fetchEngineStatuses, fetchReadinessByEngine, startEngineInstall, startEngineLogin } from './engineSetupApi';
import type { EngineId, EngineSnapshot, EngineStatus, Readiness } from './engineSetupModel';

type Loaders = {
  statuses: () => Promise<EngineStatus[]>;
  readiness: () => Promise<Map<EngineId, { state: Readiness; fixCommand: string | null }>>;
};

const defaultLoaders: Loaders = { statuses: fetchEngineStatuses, readiness: fetchReadinessByEngine };

type EngineSetupState = {
  snapshots: Map<EngineId, EngineSnapshot>;
  loaded: boolean;
  error: string | null;
  loginMessage: Map<EngineId, string>;
  refresh: (loaders?: Loaders) => Promise<void>;
  install: (engine: EngineId) => Promise<void>;
  login: (engine: EngineId) => Promise<void>;
};

let refreshGeneration = 0;

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const useEngineSetupStore = create<EngineSetupState>()((set, get) => ({
  snapshots: new Map(),
  loaded: false,
  error: null,
  loginMessage: new Map(),

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

  install: async (engine) => {
    try {
      await startEngineInstall(engine);
    } catch (error) {
      set({ error: toMessage(error) });
    }
    await get().refresh();
  },

  login: async (engine) => {
    let message: string | null;
    try {
      const result = await startEngineLogin(engine);
      message = result.ok ? null : result.message;
    } catch (error) {
      message = toMessage(error);
    }
    const loginMessage = new Map(get().loginMessage);
    if (message) loginMessage.set(engine, message);
    else loginMessage.delete(engine);
    set({ loginMessage });
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

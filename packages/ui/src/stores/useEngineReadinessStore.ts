/**
 * Which engines' CLIs cannot run on the connected server, so the composer's
 * model picker can grey out their models. The server answers from the same
 * checks as its provider catalog and never waits for a CLI
 * (`GET /api/engines/readiness`, *Catalog* in
 * `packages/web/server/lib/engine/DOCUMENTATION.md`). An engine the server has
 * not checked yet, a runtime without engines and a failed read grey nothing
 * out. Nothing here is persisted.
 */
import React from 'react';
import { z } from 'zod';
import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';

const readinessEntrySchema = z.object({
  providerID: z.string().min(1),
  // A state this build does not know greys nothing out.
  state: z.enum(['unknown', 'ready', 'not-installed', 'signed-out']).catch('unknown'),
  fixCommand: z.string().min(1).nullable().catch(null),
});

// One malformed entry is dropped; the other engines still count.
const readinessResponseSchema = z.object({
  data: z.array(readinessEntrySchema.nullable().catch(null)),
});

/** Why an engine's models cannot be picked, and the terminal command that fixes it when the server knows one. */
interface ProviderUnavailability {
  reason: 'not-installed' | 'signed-out';
  fixCommand: string | null;
}

/** Engines that cannot run, by the provider id their models carry. */
export type UnavailableProviders = ReadonlyMap<string, ProviderUnavailability>;

/**
 * What one read learned: the engines that cannot run, and whether any engine
 * was not ready or not checked yet. The server starts its check of such an
 * engine with the read, so a later read can know more.
 */
export interface EngineReadinessRead {
  unavailable: UnavailableProviders;
  pending: boolean;
}

/** The readiness, or null when this runtime has no such route (404), as a server from before engines. Throws on any other failure. */
export const fetchEngineReadiness = async (): Promise<EngineReadinessRead | null> => {
  const response = await runtimeFetch('/api/engines/readiness');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Engine readiness request failed (${response.status})`);
  const { data } = readinessResponseSchema.parse(await response.json());
  const unavailable = new Map<string, ProviderUnavailability>();
  let pending = false;
  for (const entry of data) {
    if (!entry) continue;
    if (entry.state !== 'ready') pending = true;
    if (entry.state === 'not-installed' || entry.state === 'signed-out') {
      unavailable.set(entry.providerID, { reason: entry.state, fixCommand: entry.fixCommand });
    }
  }
  return { unavailable, pending };
};

const NONE: UnavailableProviders = new Map();

interface EngineReadinessStoreState {
  unavailableProviders: UnavailableProviders;
  loaded: boolean;
  /**
   * Reads the readiness again and resolves whether a later read could know
   * more. A failed read keeps what was known. `load` is the read itself.
   */
  refresh: (load?: () => Promise<EngineReadinessRead | null>) => Promise<boolean>;
  resetForRuntimeSwitch: () => void;
}

/** Bumped on every read and every runtime switch; an answer from an older generation is dropped. */
let readGeneration = 0;

export const useEngineReadinessStore = create<EngineReadinessStoreState>()((set) => ({
  unavailableProviders: NONE,
  loaded: false,

  refresh: async (load = fetchEngineReadiness) => {
    const generation = ++readGeneration;
    try {
      const read = await load();
      if (generation !== readGeneration) return false;
      set({ unavailableProviders: read?.unavailable ?? NONE, loaded: true });
      return read?.pending ?? false;
    } catch (error) {
      console.warn('[engines] readiness read failed:', error instanceof Error ? error.message : error);
      return false;
    }
  },

  resetForRuntimeSwitch: () => {
    readGeneration += 1;
    set({ unavailableProviders: NONE, loaded: false });
  },
}));

// The server's check of an engine that was not ready takes about a second.
const FOLLOW_UP_READ_MS = 2_000;

/**
 * The engines that cannot run, read once before the picker first opens and
 * again each time it opens. When a read finds an engine that was not ready or
 * not checked yet, one more read follows while the picker stays open, so an
 * engine the user just installed or signed in to is offered again.
 */
export const useUnavailableProviders = (open: boolean): UnavailableProviders => {
  const unavailableProviders = useEngineReadinessStore((state) => state.unavailableProviders);

  React.useEffect(() => {
    const { loaded, refresh } = useEngineReadinessStore.getState();
    if (!loaded) void refresh();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const { refresh } = useEngineReadinessStore.getState();
    let closed = false;
    let followUp: ReturnType<typeof setTimeout> | undefined;
    void refresh().then((pending) => {
      if (closed || !pending) return;
      followUp = setTimeout(() => { void refresh(); }, FOLLOW_UP_READ_MS);
    });
    return () => {
      closed = true;
      clearTimeout(followUp);
    };
  }, [open]);

  return unavailableProviders;
};

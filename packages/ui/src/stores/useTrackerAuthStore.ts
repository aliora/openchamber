import { createStore } from 'zustand/vanilla';
import { defineHostStore, defineHostValue } from '@/lib/hosts/runtime/host-bindings';
import type { TrackerAPI, TrackerAuthStatus, TrackerProviderId } from '@/lib/api/types';
import { useTrackerRegistry } from '@/lib/trackers/registry';

type TrackerAuthStatusWithError = TrackerAuthStatus & { error?: string };

type TrackerAuthEntry = {
  status: TrackerAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
};

type TrackerAuthStore = {
  /** One entry per tracker id; a tracker never asked has none. */
  entries: Readonly<Record<TrackerProviderId, TrackerAuthEntry>>;
  setStatus: (provider: TrackerProviderId, status: TrackerAuthStatusWithError | null) => void;
  refreshStatus: (
    trackers: TrackerAPI | undefined,
    provider: TrackerProviderId,
    options?: { force?: boolean },
  ) => Promise<TrackerAuthStatusWithError | null>;
  refreshAll: (
    trackers: TrackerAPI | undefined,
    providers: readonly TrackerProviderId[],
    options?: { force?: boolean },
  ) => Promise<void>;
  /**
   * Trackers are authenticated on the OpenChamber instance, not in the
   * browser, so these statuses belong to whichever instance is connected.
   * Switching instances must drop them, otherwise the previous instance's
   * login stays on screen and its item surfaces remain usable against a
   * runtime that has no such tracker.
   */
  resetForRuntimeSwitch: () => void;
};

const EMPTY_ENTRY: TrackerAuthEntry = { status: null, isLoading: false, hasChecked: false };

type AuthRefreshes = {
  inFlight: Map<TrackerProviderId, Promise<TrackerAuthStatusWithError | null>>;
  // Bumped by every reset so a response already in flight for the previous
  // instance cannot write itself into the new instance's status.
  generation: number;
};

const authRefreshes = defineHostValue<AuthRefreshes>(() => ({ inFlight: new Map(), generation: 0 }));

export const useTrackerAuthStore = defineHostStore<TrackerAuthStore>('tracker-auth', (host) => createStore<TrackerAuthStore>()((set, get) => {
  const patch = (provider: TrackerProviderId, next: Partial<TrackerAuthEntry>) => set((state) => ({
    entries: { ...state.entries, [provider]: { ...(state.entries[provider] ?? EMPTY_ENTRY), ...next } },
  }));

  return {
    entries: {},
    setStatus: (provider, status) => patch(provider, { status, hasChecked: true }),
    refreshStatus: async (trackers, provider, options) => {
      const current = get().entries[provider] ?? EMPTY_ENTRY;
      if (!trackers) return current.status;
      if (current.hasChecked && !options?.force) return current.status;
      const refreshes = host.run(authRefreshes);
      const { inFlight } = refreshes;
      const pending = inFlight.get(provider);
      if (pending) return pending;

      const generation = refreshes.generation;
      patch(provider, { isLoading: true });
      const request = (async () => {
        try {
          const status = await host.run(() => trackers.authStatus(provider));
          if (generation !== refreshes.generation) return null;
          patch(provider, { status, isLoading: false, hasChecked: true });
          return status;
        } catch (error) {
          if (generation !== refreshes.generation) return null;
          const message = error instanceof Error ? error.message : String(error);
          // A failed request is not an authoritative disconnect. Keep the last
          // known status and leave `hasChecked` as it was, so the next caller
          // retries instead of hiding the tracker for the rest of the session.
          const previous = get().entries[provider]?.status ?? null;
          patch(provider, {
            status: previous ? { ...previous, error: message } : { connected: false, error: message },
            isLoading: false,
          });
          return null;
        }
      })().finally(() => {
        if (inFlight.get(provider) === request) inFlight.delete(provider);
      });
      inFlight.set(provider, request);
      return request;
    },
    refreshAll: async (trackers, providers, options) => {
      const { refreshStatus } = get();
      await Promise.all(providers.map((provider) => refreshStatus(trackers, provider, options)));
    },
    resetForRuntimeSwitch: () => {
      const refreshes = host.run(authRefreshes);
      refreshes.generation += 1;
      refreshes.inFlight.clear();
      set({ entries: {} });
    },
  };
}));

/** A tracker's auth entry; the empty one until it was asked. */
export const useTrackerAuthEntry = (provider: TrackerProviderId | null | undefined): TrackerAuthEntry => (
  useTrackerAuthStore((state) => (provider ? state.entries[provider] : undefined) ?? EMPTY_ENTRY)
);

/** Whether the tracker answered that an account is connected. */
export const isTrackerConnected = (entry: TrackerAuthEntry | undefined): boolean => entry?.status?.connected === true;

/** The id of the tracker's current account, '' while unknown: the scope of its lists and details. */
export const currentTrackerAccountId = (entry: TrackerAuthEntry | undefined): string => {
  const status = entry?.status;
  return status?.connected ? status.account?.id ?? '' : '';
};

/**
 * Reads which trackers the server serves, then each one's auth status. Called
 * where source-control auth is refreshed: on connect, on resume, after an
 * instance switch.
 */
export async function refreshTrackers(trackers: TrackerAPI | undefined): Promise<void> {
  const registry = useTrackerRegistry.getState();
  await registry.refresh(trackers);
  const providers = useTrackerRegistry.getState().ordered.map((descriptor) => descriptor.id);
  await useTrackerAuthStore.getState().refreshAll(trackers, providers, { force: true });
}

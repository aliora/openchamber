import { createStore } from 'zustand/vanilla';
import { defineHostStore, defineHostValue } from '@/lib/hosts/runtime/host-bindings';
import type { LinearAuthStatus, RuntimeAPIs } from '@/lib/api/types';

type LinearAuthStatusWithError = LinearAuthStatus & { error?: string };

type LinearAuthStore = {
  status: LinearAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: LinearAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeLinear?: RuntimeAPIs['linear'],
    options?: { force?: boolean }
  ) => Promise<LinearAuthStatusWithError | null>;
  /**
   * Linear is authenticated on the OpenChamber instance, not in the browser, so
   * this status belongs to whichever instance is connected. Switching instances
   * must drop it — otherwise the previous instance's login stays on screen and
   * its issue surfaces remain usable against a runtime that has no Linear at all.
   */
  resetForRuntimeSwitch: () => void;
};

const fetchStatus = async (
  runtimeLinear?: RuntimeAPIs['linear']
): Promise<LinearAuthStatusWithError> => {
  if (!runtimeLinear) {
    return { connected: false };
  }
  return runtimeLinear.authStatus();
};

type AuthRefreshes = {
  inFlight: Promise<LinearAuthStatusWithError | null> | null;
  // Bumped by every reset so a response already in flight for the previous
  // instance cannot write itself into the new instance's status.
  generation: number;
};

const authRefreshes = defineHostValue<AuthRefreshes>(() => ({ inFlight: null, generation: 0 }));

export const useLinearAuthStore = defineHostStore<LinearAuthStore>('linear-auth', (host) => createStore<LinearAuthStore>()((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeLinear, options) => {
    if (!runtimeLinear) {
      return get().status;
    }
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    const refreshes = host.run(authRefreshes);
    if (refreshes.inFlight) return refreshes.inFlight;

    const generation = refreshes.generation;
    set({ isLoading: true });
    refreshes.inFlight = (async () => {
      try {
        const payload = await host.run(() => fetchStatus(runtimeLinear));
        if (generation !== refreshes.generation) return null;
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        if (generation !== refreshes.generation) return null;
        const message = error instanceof Error ? error.message : String(error);
        // A failed request is not an authoritative disconnect. Keep the last
        // known status and leave `hasChecked` false so the next caller retries
        // instead of hiding Linear for the rest of the session.
        set((state) => ({
          status: state.status
            ? { ...state.status, error: message }
            : { connected: false, error: message },
          isLoading: false,
        }));
        return null;
      }
    })().finally(() => { refreshes.inFlight = null; });

    return refreshes.inFlight;
  },
  resetForRuntimeSwitch: () => {
    const refreshes = host.run(authRefreshes);
    refreshes.generation += 1;
    refreshes.inFlight = null;
    set({ status: null, isLoading: false, hasChecked: false });
  },
})));

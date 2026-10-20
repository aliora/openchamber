import { createStore } from 'zustand/vanilla';
import { defineHostStore, defineHostValue, hostStoresLive } from '@/lib/hosts/runtime/host-bindings';

import { loadGuestOauthStatus, type GuestOauthStatus } from './oauth.ts';

type GuestOauthState = {
  byId: Record<string, GuestOauthStatus>;
  setStatus: (guestId: string, status: GuestOauthStatus) => void;
  refresh: (guestId: string) => Promise<GuestOauthStatus | null>;
  resetForRuntimeSwitch: () => void;
};

const generations = defineHostValue(() => ({ current: 0 }));

export const useGuestOauthStore = defineHostStore<GuestOauthState>('guest-oauth', (host) => createStore<GuestOauthState>()((set) => ({
  byId: {},
  setStatus: (guestId, status) => {
    set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
  },
  refresh: async (guestId) => {
    const generation = host.run(generations);
    const requestGeneration = generation.current;
    const status = await host.run(() => loadGuestOauthStatus(guestId));
    if (requestGeneration !== generation.current || !hostStoresLive(host)) return null;
    if (status) {
      set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
    }
    return status;
  },
  resetForRuntimeSwitch: () => {
    host.run(generations).current += 1;
    set({ byId: {} });
  },
})));

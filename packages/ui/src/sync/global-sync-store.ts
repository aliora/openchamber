import { createStore } from "zustand/vanilla"
import { defineHostStore } from "@/lib/hosts/runtime/host-bindings"
import type { GlobalState } from "./types"
import { INITIAL_GLOBAL_STATE } from "./types"

type GlobalSyncStore = GlobalState & {
  actions: {
    set: (patch: Partial<GlobalState>) => void
    reset: () => void
  }
}

export const useGlobalSyncStore = defineHostStore<GlobalSyncStore>("global-sync", () => createStore<GlobalSyncStore>()((set) => ({
  ...INITIAL_GLOBAL_STATE,
  actions: {
    set: (patch) => set(patch),
    reset: () => set(INITIAL_GLOBAL_STATE),
  },
})))

import { isCapacitorApp } from "@/lib/platform"

type HostSyncSurface = "desktop" | "capacitor"

export type DirectoryStoreLimits = {
  readonly max: number
  readonly idleTtlMs: number
}

export type HostSyncPolicy = {
  readonly focused: boolean
  readonly watchdog: boolean
  readonly directoryStores: DirectoryStoreLimits | null
  readonly sessionCacheLimit: number | null
  readonly evictionIntervalMs: number
}

const MINUTE_MS = 60_000

export const FOCUSED_HOST_SYNC_POLICY: HostSyncPolicy = {
  focused: true,
  watchdog: true,
  directoryStores: null,
  sessionCacheLimit: null,
  evictionIntervalMs: 0,
}

const BACKGROUND_HOST_SYNC_POLICIES = {
  desktop: {
    focused: false,
    watchdog: false,
    directoryStores: { max: 8, idleTtlMs: 10 * MINUTE_MS },
    sessionCacheLimit: 2,
    evictionIntervalMs: MINUTE_MS,
  },
  capacitor: {
    focused: false,
    watchdog: false,
    directoryStores: { max: 2, idleTtlMs: 2 * MINUTE_MS },
    sessionCacheLimit: 0,
    evictionIntervalMs: 30_000,
  },
} satisfies Record<HostSyncSurface, HostSyncPolicy>

export const currentHostSyncSurface = (): HostSyncSurface => (isCapacitorApp() ? "capacitor" : "desktop")

export const hostSyncPolicy = (focused: boolean, surface: HostSyncSurface): HostSyncPolicy => (
  focused ? FOCUSED_HOST_SYNC_POLICY : BACKGROUND_HOST_SYNC_POLICIES[surface]
)

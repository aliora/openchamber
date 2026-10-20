import type { CatalogKind } from "@/lib/opencode/events"
import type { OpencodeService } from "@/lib/opencode/client"
import { defineHostValue } from "@/lib/hosts/runtime/host-bindings"
import type { HostRuntime } from "@/lib/hosts/runtime/types"
import type { SessionMaterializationRequest } from "./materialization"

type PendingSessionMaterialization = {
  enqueuedAt: number
  request: SessionMaterializationRequest
}

export type CatalogRuntime = {
  host: HostRuntime
  sdk: ReturnType<OpencodeService["getSdkClient"]>
}

type CatalogReloadBatch = {
  readonly directoriesByKind: Map<CatalogKind, Set<string>>
  readonly currentDirectoryKinds: Set<CatalogKind>
  runtime: CatalogRuntime | null
  timer: ReturnType<typeof setTimeout> | null
}

type SyncBootState = {
  booting: boolean
  bootedAt: number
  generation: number
}

type SyncHostState = {
  readonly boot: SyncBootState
  readonly pendingMaterializations: Map<string, PendingSessionMaterialization>
  readonly statusPollingDirectories: Set<string>
  readonly childDiscoveryDirectories: Set<string>
  readonly completionPolls: Map<string, ReturnType<typeof setTimeout>>
  readonly catalogReload: CatalogReloadBatch
  readonly mcpStatusRefreshTimers: Map<string, ReturnType<typeof setTimeout>>
  readonly permissionsAwaitingAutoAnswer: Map<string, () => void>
  readonly leftForUserBeforeAsked: Set<string>
}

const createSyncHostState = (): SyncHostState => ({
  boot: { booting: false, bootedAt: 0, generation: 0 },
  pendingMaterializations: new Map(),
  statusPollingDirectories: new Set(),
  childDiscoveryDirectories: new Set(),
  completionPolls: new Map(),
  catalogReload: { directoriesByKind: new Map(), currentDirectoryKinds: new Set(), runtime: null, timer: null },
  mcpStatusRefreshTimers: new Map(),
  permissionsAwaitingAutoAnswer: new Map(),
  leftForUserBeforeAsked: new Set(),
})

const readSyncHostState = defineHostValue(createSyncHostState)

export const syncHostStateOf = (host: HostRuntime): SyncHostState => host.run(readSyncHostState)

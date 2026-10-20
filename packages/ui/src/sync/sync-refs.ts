/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { OpenCodeClient } from "@opencode/client"
import { defineHostValue } from "@/lib/hosts/runtime/host-bindings"
import type { Config } from "@/lib/opencode/model"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import type { State } from "./types"

type SyncRefs = {
  childStores: ChildStoreManager | null
  directory: string
  registerSessionDirectory: ((sessionID: string, directory: string) => void) | null
  cachedSessionManager: ChildStoreManager | null
  cachedSessionSlices: Map<string, State["session"]>
  cachedSessionsById: Map<string, State["session"][number]>
  cachedSessionDirectoryById: Map<string, string>
}

const syncRefs = defineHostValue<SyncRefs>(() => ({
  childStores: null,
  directory: "",
  registerSessionDirectory: null,
  cachedSessionManager: null,
  cachedSessionSlices: new Map(),
  cachedSessionsById: new Map(),
  cachedSessionDirectoryById: new Map(),
}))
const configListeners = new Set<(directory: string, config: Config) => void>()

export function setSyncRefs(
  _sdk: OpenCodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  const refs = syncRefs()
  refs.childStores = childStores
  if (refs.cachedSessionManager !== childStores) {
    refs.cachedSessionManager = null
    refs.cachedSessionSlices = new Map()
    refs.cachedSessionsById = new Map()
    refs.cachedSessionDirectoryById = new Map()
  }
  refs.directory = directory
  if (registerSessionDirectory) {
    refs.registerSessionDirectory = registerSessionDirectory
  }
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  syncRefs().registerSessionDirectory?.(sessionID, directory)
}

export function getSyncChildStores(): ChildStoreManager {
  const stores = syncRefs().childStores
  if (!stores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return stores
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const refs = syncRefs()
  const stores = refs.childStores
  if (!stores) return undefined
  const dir = directory || refs.directory
  if (!dir) return undefined
  return stores.getState(dir)
}

/** Read resolved OpenCode config from a directory child store, if bootstrapped. */
export function getSyncConfig(directory?: string): Config | undefined {
  const config = getDirectoryState(directory)?.config
  return config && Object.keys(config).length > 0 ? config : undefined
}

export function subscribeToSyncConfigChanges(listener: (directory: string, config: Config) => void): () => void {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}

export function emitSyncConfigChanged(directory: string, config: Config): void {
  if (!directory) return
  for (const listener of configListeners) {
    listener(directory, config)
  }
}

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  return Array.from(getAllSyncSessionMap().values())
}

/** Read the cached cross-directory session index, rebuilding only when a session slice changes. */
export function getAllSyncSessionMap(): ReadonlyMap<string, State["session"][number]> {
  const refs = syncRefs()
  const stores = refs.childStores
  if (!stores) return refs.cachedSessionsById

  let changed = refs.cachedSessionManager !== stores || refs.cachedSessionSlices.size !== stores.children.size
  for (const [directory, store] of stores.children) {
    if (refs.cachedSessionSlices.get(directory) !== store.getState().session) {
      changed = true
      break
    }
  }
  if (!changed) return refs.cachedSessionsById

  const nextSlices = new Map<string, State["session"]>()
  const nextSessionsById = new Map<string, State["session"][number]>()
  const nextDirectoriesById = new Map<string, string>()
  for (const [directory, store] of stores.children) {
    const sessions = store.getState().session
    nextSlices.set(directory, sessions)
    for (const session of sessions) {
      if (!session?.id) continue
      nextSessionsById.set(session.id, session)
      nextDirectoriesById.set(session.id, directory)
    }
  }
  refs.cachedSessionManager = stores
  refs.cachedSessionSlices = nextSlices
  refs.cachedSessionsById = nextSessionsById
  refs.cachedSessionDirectoryById = nextDirectoriesById
  return nextSessionsById
}

/**
 * Directory of a child store that holds this session.
 *
 * This reports containment, not ownership, and a session can be held by more
 * than one store: a project's session list includes the sessions of its
 * worktrees so the sidebar can group them, so the parent repository holds
 * worktree sessions too. Ownership comes from the session record's own
 * directory; this is the fallback for a record that carries none. Returns
 * `null` when no initialized child store contains the session, which means
 * "unknown", never "no directory".
 */
export function getSyncSessionDirectory(sessionId: string): string | null {
  if (!sessionId) return null
  getAllSyncSessionMap()
  return syncRefs().cachedSessionDirectoryById.get(sessionId) ?? null
}

/** Read messages for a session from current directory's child store */
export function getSyncMessages(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.message[sessionId] ?? []
}

/** Read renderability of a session snapshot from current directory's child store */
export function getSyncSessionMaterializationStatus(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  if (!state) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  return getSessionMaterializationStatus(state, sessionId)
}

/** Read parts for a message from current directory's child store */
export function getSyncParts(messageId: string, directory?: string) {
  return getDirectoryState(directory)?.part[messageId] ?? []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}

/* oxlint-disable react/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpenCodeClient } from "@opencode/client"
import { syncEventMessageID, syncEventSessionID, type CatalogKind, type OpenchamberNotification, type SyncEvent } from "@/lib/opencode/events"
import type {
  FormRequest,
  Message,
  Part,
  PermissionRequest,
  Session,
  SessionOutcome,
  SessionStatus,
  StructuredError,
} from "@/lib/opencode/model"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isSurfaceAttended } from "@/lib/surfaceAttention"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { reduceGlobalEvent, applyDirectoryEvent, type SessionMaterializationReason } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import {
  ChildStoreManager,
  markDirectorySessionPartChanged,
  subscribeDirectoryPermission,
  subscribeDirectoryPermissions,
  subscribeDirectoryForms,
  subscribeDirectorySessionMessages,
  type DirectoryBootstrapContext,
  type DirectoryBootstrapReason,
  type DirectoryBootstrapPriority,
  type DirectoryStore,
} from "./child-store"
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
} from "./live-aggregate"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { retry } from "./retry"
import { touchStreamingSession, updateChangedStreamingSessions, updateStreamingState } from "./streaming"
import { countSyncPerformance } from "./performance-diagnostics"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { adoptSessionMove, setActionRefs } from "./session-actions"
import { setSyncRefs, getAllSyncSessions, emitSyncConfigChanged, getDirectoryState } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { stripSessionDiffSnapshots } from "./sanitize"
import { upsertSessionRecord } from "./session-records"
import {
  applySessionEventToGlobalSessions,
  applySessionEventsToGlobalSessions,
} from "./session-event-router"
import { shouldConsumeBulkArchiveEcho } from "./bulk-archive-echo"
import { applyForkedSession, noteForkedSessionPatched } from "./forked-session"
import {
  LOCATION_SCOPED_FORM_SESSION_ID,
  routeUnlocatedLocationScopedForm,
} from "./location-scoped-forms"
import { useUIStore } from "@/stores/useUIStore"
import { useBtwStore } from "@/stores/useBtwStore"
import { selectNewChildSessions } from "./child-session-discovery"
import { syncDebug } from "./debug"
import { normalizePath } from "@/lib/pathNormalization"
import { Binary } from "./binary"
import { getReconnectCandidateSessionIds, mergeBootstrapSessions } from "./reconnect-recovery"
import { messagesBefore } from "./message-ordering"
import { opencodeClient, type OpencodeService } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { isOpenChamberAutoAcceptActive, useEngineControlsStore } from "@/stores/useEngineControlsStore"
import { policySnapshotFromWire } from "@/stores/utils/permissionAutoAccept"
import { selectSafetyNetAvailable, useRoutingStore } from "@/stores/useRoutingStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { subscribeMessageQueueSync } from "./message-queue-sync"
import { seedGlobalSessionStatusFromHost } from "./host-session-status-seed"
import {
  processVSCodePermissionAutoAccept,
  processVSCodeReconciledPermissionAutoAccept,
} from "./vscode-permission-auto-accept"
import { markConfigCatalogStale, useConfigStore } from "@/stores/useConfigStore"
import { refreshStoresForCatalogKind } from "@/stores/catalogRefresh"
import { useMcpStore } from "@/stores/useMcpStore"
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { isDirectoryOfKnownSpace, isSpaceDirectoryStopped, isSpaceStopped, knownSpaceIds, refreshSpacesJourney, spaceIdsGone, spacesRuntimeGeneration, useSpacesStore } from "@/lib/spaces/spaces-store"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { toast } from "@/components/ui"
import { appendNotification } from "./notification-store"
import { recordSessionError, responseBodyOf, summarizeOpenCodeError } from "./session-error-log"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  getDirectoryOwnedSessionIds,
  setSessionParentResolver,
  useGlobalSessionStatusStore,
} from "./global-session-status"
import { applyGlobalBlockingRequestEvents, applyWaitingPageEvent, useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { applyBackgroundShellEvents, directoriesWithRunningShells, refreshBackgroundShells } from "./background-shells"
import {
  CHAT_LOCATION_RELEASE_DELAY_MS,
  WORKTREE_LOCATION_RELEASE_DELAY_MS,
  createRealLocationRelease,
  directoryUse,
  isWorktreeDirectory,
  type LocationRelease,
} from "./location-release"
import { isChatDirectoryPath, warmChatsRootDirectory } from "@/lib/chatDirectories"
import type { State } from "./types"
import {
  getSessionMaterializationRequestKey,
  getSessionMaterializationStatus,
  getStaleRunningToolMessageID,
  isSessionMaterializationStillNeeded,
  type SessionMaterializationRequest,
} from "./materialization"
import { openSessionFromToast } from "./session-navigation"
import { revealRequest } from "./request-reveal"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isFilesystemError } from "@/lib/api/files-errors"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import { sessionEvents } from "@/lib/sessionEvents"
import { fileTreeChanges } from "@/lib/fileTreeChanges"
import { listGlobalSessionPages, splitGlobalSessionsByArchived, type SessionPageLister } from "@/stores/globalSessions"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests } from "./scoped-blocking-requests"
import { EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT, buildUserMessageHistorySnapshot, type TranscriptPrompt, type UserMessageHistorySnapshot } from "./user-message-history"
import {
  EMPTY_SESSION_MESSAGE_LOAD_STATE,
  SessionMessageLoader,
  getImperativeSessionMessageLoader,
  setImperativeSessionMessageLoader,
  type SessionMessageLoadState,
} from "./session-message-loader"
import { openCodeStartupSignal } from "./opencode-startup-gate"
import { claimFirstServerConnect, notifyFirstServerConnect } from "./first-server-connect"
import { defineHostValue, hostRegistry, hostStoresLive, resolveHost } from "@/lib/hosts/runtime/host-bindings"
import type { HostId, HostRuntime } from "@/lib/hosts/runtime/types"
import { HostScopeContext } from "@/lib/hosts/runtime/HostScope"
import { currentHostKey } from "@/lib/hosts/runtime/host-key"
import { isMultiHostRuntimeEnabled } from "@/lib/hosts/runtime/multi-host-flag"
import type { HostsAPI } from "@/lib/api/types"
import { syncHostStateOf, type CatalogRuntime } from "./sync-host-state"
import { currentHostSyncSurface, FOCUSED_HOST_SYNC_POLICY, hostSyncPolicy, type HostSyncPolicy } from "./host-background-policy"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The provider's current directory as a subscribable value instead of a
 * context field. A hook that is handed an explicit directory reads a constant
 * snapshot from it and therefore does not re-render when the current
 * directory changes; a context read would re-render every consumer — every
 * sidebar row — on each cross-project switch.
 */
type CurrentDirectorySource = {
  get: () => string
  subscribe: (notify: () => void) => () => void
}

type SyncRuntime = {
  childStores: ChildStoreManager
  messageLoader: SessionMessageLoader
  runtimeKey: string
  sdk: OpenCodeClient
  currentDirectory: CurrentDirectorySource
}

type SyncSystem = SyncRuntime & {
  directory: string
}

// Subagent sessions keep their parent's turn open in the status index; the
// global sessions list knows every session's parent, children included.
setSessionParentResolver((sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId)?.parentID)

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
const SYNC_RUNTIME_CONTEXT_GLOBAL_KEY = "__openchamber_sync_runtime_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
  [SYNC_RUNTIME_CONTEXT_GLOBAL_KEY]?: React.Context<SyncRuntime | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext
const SyncRuntimeContext = syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] ?? createContext<SyncRuntime | null>(null)
syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] = SyncRuntimeContext

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

export function useSyncRuntime() {
  const ctx = useContext(SyncRuntimeContext)
  if (!ctx) throw new Error("useSyncRuntime must be used within <SyncProvider>")
  return ctx
}

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(
  selector: (states: State[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  subscribe?: (childStores: ChildStoreManager, notify: () => void) => () => void,
): T {
  const { childStores } = useSyncRuntime()
  const sourceRevisionRef = useRef(0)
  const cacheRef = useRef<{
    childStores: ChildStoreManager
    selector: (states: State[]) => T
    revision: number
    value: T
  } | null>(null)

  const getSnapshot = useCallback(() => {
    const cached = cacheRef.current
    if (
      cached
      && cached.childStores === childStores
      && cached.selector === selector
      && cached.revision === sourceRevisionRef.current
    ) {
      return cached.value
    }
    const next = selector(getLiveStates(childStores))
    const value = cached && isEqual(cached.value, next) ? cached.value : next
    cacheRef.current = { childStores, selector, revision: sourceRevisionRef.current, value }
    return value
  }, [childStores, isEqual, selector])

  const subscribeToSource = useCallback((notify: () => void) => {
    const invalidate = () => {
      sourceRevisionRef.current += 1
      notify()
    }
    // Force the post-subscribe snapshot to close the read-before-subscribe gap.
    sourceRevisionRef.current += 1
    return subscribe ? subscribe(childStores, invalidate) : childStores.subscribeAll(invalidate)
  }, [childStores, subscribe])

  return React.useSyncExternalStore(
    subscribeToSource,
    getSnapshot,
    getSnapshot,
  )
}

// ---------------------------------------------------------------------------
// Event handler — applies ordered SSE events to a cumulative per-flush draft.
// Per-event side effects remain ordered, while each directory store publishes
// once and each touched top-level slice is cloned at most once per flush.
// ---------------------------------------------------------------------------

type SessionMove = { sessionID: string; from: string; to: string }

type DirectoryEventBatch = {
  states: Map<StoreApi<DirectoryStore>, DirectoryStore>
  clonedFields: Map<StoreApi<DirectoryStore>, Set<keyof State>>
  changedStores: Set<StoreApi<DirectoryStore>>
  globalSessionEvents: SyncEvent[]
  globalStatusEventsByDirectory: Map<string, SyncEvent[]>
  /** Applied after the stores publish: a move reads and writes both stores directly. */
  sessionMoves: SessionMove[]
}

const createDirectoryEventBatch = (): DirectoryEventBatch => ({
  states: new Map(),
  clonedFields: new Map(),
  changedStores: new Set(),
  globalSessionEvents: [],
  globalStatusEventsByDirectory: new Map(),
  sessionMoves: [],
})

const getDirectoryEventState = (
  store: StoreApi<DirectoryStore>,
  batch?: DirectoryEventBatch,
): DirectoryStore => batch?.states.get(store) ?? store.getState()

const publishDirectoryEventBatch = (batch: DirectoryEventBatch): void => {
  applySessionEventsToGlobalSessions(batch.globalSessionEvents)
  for (const [directory, events] of batch.globalStatusEventsByDirectory) {
    // Before statuses: an idle that follows a command's start in the same
    // flush must see the command.
    applyBackgroundShellEvents(directory, events)
    applyGlobalSessionStatusEvents(directory, events)
    applyGlobalBlockingRequestEvents(directory, events)
  }
  for (const store of batch.changedStores) {
    const state = batch.states.get(store)
    if (!state) continue
    countSyncPerformance("directoryStorePublications")
    store.setState(state)
  }
  for (const move of batch.sessionMoves) adoptSessionMove(move.sessionID, move.from, move.to)
}

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useGlobalSessionStatusStore(
    useCallback((state) => state.statusById.get(sessionId)?.status, [sessionId]),
  )
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessionStatuses(states), []),
    areStatusMapsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session_status,
        notify,
      ),
      [],
    ),
  )
}

const subscribeLiveSessionLists = (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
  (state: State) => state.session,
  notify,
)

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      return aggregateLiveSessions(states)
    }, []),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

const EMPTY_LIVE_SESSIONS: Session[] = []

/**
 * Live sessions whose ids are not in `excludedIds`, newest first. Updates to
 * an excluded session (a `time.updated` bump on every streamed step) do not
 * re-render the caller.
 */
export function useLiveSessionsExcluding(excludedIds: ReadonlySet<string>): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      const sessions = aggregateLiveSessions(states).filter((session) => !excludedIds.has(session.id))
      return sessions.length === 0 ? EMPTY_LIVE_SESSIONS : sessions
    }, [excludedIds]),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

const BOOT_DEBOUNCE_MS = 1500
const RECONNECT_MESSAGE_LIMIT = 30
const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30
const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000
const ACTIVE_SESSION_STALE_EVENT_MS = 20_000
const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000
const CHILD_SESSION_DISCOVERY_INTERVAL_MS = 15_000

// Active-session watchdog network calls run under the shared
// background-network gate (see lib/background-network.ts). The watchdog walks
// every initialized child store each tick and fires a status poll plus a
// child-session discovery list per directory with active candidates — on
// startup with many cache-hydrated directories that is dozens of simultaneous
// requests, which would otherwise queue interactive traffic (opening a
// session) behind them on the browser's ~6 sockets per origin. Later ticks
// still cover every directory via the per-directory timestamps.

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

// ---------------------------------------------------------------------------
// Session materialization scheduler — when local message/part state is incomplete,
// fetch the canonical session snapshot and materialize messages and parts together.
// Tracked per-runtime and directory, deduplicated, and auto-expiring.
// ---------------------------------------------------------------------------

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000

// How long to wait for the turn's own `session.idle` before spending a request.
export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750

function enqueueSessionMaterialization(
  host: HostRuntime,
  directory: string,
  sessionID: string,
  childStores: ChildStoreManager,
  request: SessionMaterializationRequest,
) {
  if (!directory || directory === "global" || !sessionID) return
  const pendingSessionMaterializations = syncHostStateOf(host).pendingMaterializations
  const k = getSessionMaterializationRequestKey(host.id, directory, sessionID)
  const existing = pendingSessionMaterializations.get(k)
  if (existing && Date.now() - existing.enqueuedAt < SESSION_MATERIALIZATION_COOLDOWN_MS) {
    const settlementMustFollowEarlierRecovery = request.reason === "settled-running-tool"
      && existing.request.reason !== "settled-running-tool"
    if (!settlementMustFollowEarlierRecovery) return
  }

  const pending = { enqueuedAt: Date.now(), request }
  pendingSessionMaterializations.set(k, pending)
  countSyncPerformance("materializationEnqueues")
  if (request.reason === "empty-assistant-message") {
    countSyncPerformance("materializationEmptyAssistantEnqueues")
  } else if (request.reason === "missing-owning-message") {
    countSyncPerformance("materializationMissingMessageEnqueues")
  } else if (request.reason === "orphan-delta" || request.reason === "missing-delta-part") {
    countSyncPerformance("materializationMissingPartEnqueues")
  } else {
    countSyncPerformance("materializationLifecycleEnqueues")
  }

  const run = async () => {
    if (!hostStoresLive(host)) {
      if (pendingSessionMaterializations.get(k) === pending) {
        pendingSessionMaterializations.delete(k)
      }
      return
    }
    const store = childStores.getChild(directory)
    if (!store) {
      if (pendingSessionMaterializations.get(k) === pending) {
        pendingSessionMaterializations.delete(k)
      }
      return
    }
    try {
      if (!isSessionMaterializationStillNeeded(store.getState(), sessionID, request)) {
        countSyncPerformance("materializationPreflightSkips")
        return
      }
      countSyncPerformance("materializationRequests")
      await materializeSessionFromServer(host, directory, sessionID, store, {
        ...request,
        isStale: () => childStores.children.get(directory) !== store
          || pendingSessionMaterializations.get(k) !== pending,
      })
    } catch {
      // Transient failure — next SSE event or reconnect will catch up.
    } finally {
      const remainingCooldown = SESSION_MATERIALIZATION_COOLDOWN_MS - (Date.now() - pending.enqueuedAt)
      if (remainingCooldown <= 0) {
        if (pendingSessionMaterializations.get(k) === pending) {
          pendingSessionMaterializations.delete(k)
        }
      } else {
        setTimeout(() => {
          if (pendingSessionMaterializations.get(k) === pending) {
            pendingSessionMaterializations.delete(k)
          }
        }, remainingCooldown)
      }
    }
  }

  // Start after the current ordered event batch, then recheck local state
  // before issuing HTTP in case another event in the batch repaired it.
  void Promise.resolve().then(run)
}

async function materializeSessionFromServer(
  host: HostRuntime,
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
  options?: SessionMaterializationRequest & { isStale?: () => boolean },
) {
  const readSdk = () => host.run(() => opencodeClient.getSdkClient())
  const sdk = readSdk()
  const isStale = () => options?.isStale?.() || !hostStoresLive(host) || readSdk() !== sdk
  const statusBeforeMaterialization = store.getState().session_status?.[sessionID]
  syncDebug.recovery.materializing({
    reason: options?.reason ?? "ensure-session-messages",
    directory,
    sessionID,
    messageID: options?.messageID,
    partID: options?.partID,
  })
  const loader = getImperativeSessionMessageLoader()
  if (!loader || isStale()) return
  await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
  if (isStale()) return
  if (loader.getSnapshot({ directory, sessionID }).status === "error") {
    throw loader.getSnapshot({ directory, sessionID }).error ?? new Error("Session materialization failed")
  }

  if (statusBeforeMaterialization && statusBeforeMaterialization.type !== "idle" && !isStale()) {
    await resyncDirectorySessionStatuses(host, directory, store, [sessionID], "authoritative", isStale)
  }
  if (!isStale()) {
    markRecordedInterruptedTurn(store, sessionID)
  }
}

type ActiveSession = { directory: string; sessionId: string }

const activeSessionByHost = new Map<HostId, ActiveSession>()
const externallyViewedSessions = new Map<string, number>()
const EXTERNAL_VIEW_TTL_MS = 15_000

const viewedDirectoryPrefix = (hostId: HostId, directory: string) => `${hostId}\n${directory}\n`
const viewedSessionKey = (hostId: HostId, directory: string, sessionId: string) => `${viewedDirectoryPrefix(hostId, directory)}${sessionId}`

function pruneExternallyViewedSessions(now = Date.now()) {
  for (const [key, expiresAt] of externallyViewedSessions.entries()) {
    if (expiresAt <= now) {
      externallyViewedSessions.delete(key)
    }
  }
}
const pendingFormToastIds = new Map<HostId, Set<string>>()
const pendingPermissionToastIds = new Map<HostId, Set<string>>()
const pendingVSCodePermissionEvents = new Map<string, symbol>()

const toastIdsOf = (idsByHost: Map<HostId, Set<string>>, host: HostRuntime): Set<string> => {
  const existing = idsByHost.get(host.id)
  if (existing) return existing
  const created = new Set<string>()
  idsByHost.set(host.id, created)
  return created
}

const getVSCodePermissionEventKey = (
  runtimeKey: string,
  directory: string,
  sessionID?: string,
  requestID?: string,
): string | null => {
  const requestKey = getPermissionToastKey(sessionID, requestID)
  return requestKey ? JSON.stringify([runtimeKey, directory, requestKey]) : null
}

const getFormToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

/** A pending form has no question text on the wire — only the form's title. */
const FORM_TOAST_DESCRIPTION = "Agent is waiting for your input"

/** "Open session" on a question or permission toast also brings that request into view. */
const openRequestFromToast = (sessionID: string, directory: string, requestID: string) => {
  openSessionFromToast(sessionID, directory)
  revealRequest(requestID)
}

/** A location-scoped form names no session to open; the toast then only announces it. */
const formToastAction = (sessionID: string, directory: string, formID: string) => (
  sessionID === LOCATION_SCOPED_FORM_SESSION_ID
    ? undefined
    : { label: "Open session", onClick: () => openRequestFromToast(sessionID, directory, formID) }
)

/** Blank server strings mean "absent" here, not "empty title". */
const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const notificationToastId = (kind?: string, title?: string, body?: string, tag?: string): string | undefined => {
  if (tag) return tag
  const fallback = [kind, title, body].filter(Boolean).join("|")
  return fallback || undefined
}

const showPluginNotificationToast = (kind?: string, title?: string, body?: string, tag?: string): void => {
  if (kind !== "plugin" || !title) return
  toast.info(title, {
    id: notificationToastId(kind, title, body, tag),
    description: body,
  })
}

const isUiFocused = (): boolean => (
  typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
)

/**
 * OpenChamber's own notification frame: the agent-completion notice for
 * desktop, VS Code and mobile (the web surface has its own stream), plus the
 * toast raised when a managed OpenCode restart interrupted a turn.
 */
const handleUiNotificationEvent = (notification: OpenchamberNotification, fallbackDirectory: string): void => {
  const kind = trimmedOrUndefined(notification.kind)
  const sessionId = trimmedOrUndefined(notification.sessionId)
  const directory = trimmedOrUndefined(notification.directory)
    ?? (fallbackDirectory !== "global" ? fallbackDirectory : "")
  const title = trimmedOrUndefined(notification.title)
  const body = trimmedOrUndefined(notification.body)
  const tag = trimmedOrUndefined(notification.tag)

  if (kind === "opencode-restart-interrupted") {
    const dictionary = useI18nStore.getState().dictionary
    const title = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.title")
    const options = {
      id: "opencode-restart-interrupted",
      description: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.description"),
      duration: Infinity,
    }
    if (sessionId && directory) {
      toast.info(title, {
        ...options,
        action: {
          label: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.openSession"),
          onClick: () => openSessionFromToast(sessionId, directory),
        },
      })
    } else {
      toast.info(title, options)
    }
  } else if (notification.showWhenFocused === true && isUiFocused()) {
    showPluginNotificationToast(kind, title, body, tag)
  }

  // The local desktop shell already delivered this one natively.
  if (
    (notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true)
    && currentHostKey() === "local"
  ) return

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) return

  void notifications.notifyAgentCompletion({
    title,
    body,
    tag,
    kind,
    sessionId,
    directory: directory || undefined,
    runtimeKey: currentHostKey(),
    requireHidden: notification.kind === "plugin" ? true : notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })
}

export function setActiveSession(directory: string, sessionId: string) {
  const host = resolveHost()
  const previousDirectory = activeSessionByHost.get(host.id)?.directory ?? ""
  activeSessionByHost.set(host.id, { directory, sessionId })
  getImperativeSessionMessageLoader()?.scheduleCacheRetention(previousDirectory)
  getImperativeSessionMessageLoader()?.touchSessionCache({ directory, sessionID: sessionId })
}

export function setExternallyViewedSession(directory: string, sessionId: string, viewed: boolean) {
  if (!directory || !sessionId) return
  const key = viewedSessionKey(resolveHost().id, directory, sessionId)
  if (!viewed) {
    externallyViewedSessions.delete(key)
    getImperativeSessionMessageLoader()?.scheduleCacheRetention(directory)
    return
  }
  externallyViewedSessions.set(key, Date.now() + EXTERNAL_VIEW_TTL_MS)
}

function getActiveSession(host: HostRuntime): ActiveSession | null {
  const active = activeSessionByHost.get(host.id)
  return active?.directory && active.sessionId ? active : null
}

/** A side panel in this window shows a session of `directory`. */
function isDirectoryExternallyViewed(host: HostRuntime, directory: string): boolean {
  pruneExternallyViewedSessions()
  const prefix = viewedDirectoryPrefix(host.id, directory)
  for (const key of externallyViewedSessions.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

function isViewedInCurrentSession(host: HostRuntime, directory: string, sessionId?: string): boolean {
  if (!sessionId) return false
  if (host.id !== hostRegistry.focused().id) return false
  const active = getActiveSession(host)
  // A location-scoped form is docked in whichever session of its directory is
  // open, so looking at any session there is looking at the form.
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) {
    return Boolean(active && directory === active.directory && isSurfaceAttended())
  }
  if (
    active
    && directory === active.directory && sessionId === active.sessionId
    // The user must actually see the surface for the active session to count
    // as "seen": if the app is minimized, in the background, or (in VS Code)
    // the chat view is hidden, a turn finishing in the selected session still
    // raises an unseen marker.
    && isSurfaceAttended()
  ) return true
  pruneExternallyViewedSessions()
  return externallyViewedSessions.has(viewedSessionKey(host.id, directory, sessionId))
}

function isRecentBoot(host: HostRuntime) {
  const { boot } = syncHostStateOf(host)
  return boot.booting || Date.now() - boot.bootedAt < BOOT_DEBOUNCE_MS
}

function getViewedSessionMaterializationTarget(host: HostRuntime, directory: string) {
  const active = getActiveSession(host)
  if (!active || directory !== active.directory) return null
  return active
}

const toSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => status

function getActiveSessionCandidateIds(host: HostRuntime, directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(host, directory),
  })
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

// How a `/api/session/active` snapshot is reconciled into the store.
//
// The snapshot lists only active (busy/retry) sessions across every
// directory; an absent candidate means "idle per this snapshot".
//
// - "monotonic": only confirm/raise active status. Never lowers a busy/retry
//   session to idle. Used by the periodic watchdog poll — real idle arrives via
//   SSE (session.status / session.idle) or via an authoritative resync that the
//   watchdog escalates to when it detects a stale busy entry. This keeps the
//   blind 5s poll from clobbering live state on a transient/misscoped snapshot.
// - "authoritative": treat the snapshot as ground truth — absent/idle candidates
//   are lowered to idle. Used by reconnect/escalated resyncs, a deliberate edge
//   where the live server snapshot is the source of truth (mirrors the bootstrap
//   snapshot). The snapshot wins over any derived message state here.
type StatusSnapshotMode = "monotonic" | "authoritative"

export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextInvalidated: Record<string, true> | undefined
    const draft = () => (next ??= { ...current })

    for (const sessionId of candidateSessionIds) {
      const incoming = toSessionStatus(snapshot[sessionId])
      if (mode === "authoritative" && state.sessionStatusInvalidated?.[sessionId]) {
        // The successful snapshot supersedes the archive's discarded status.
        nextInvalidated ??= { ...state.sessionStatusInvalidated }
        delete nextInvalidated[sessionId]
        changed = true
      }

      if (incoming && incoming.type !== "idle") {
        // Confirm or raise active status (catches a busy event the SSE missed).
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        continue
      }

      // Snapshot reports this candidate idle (absent, or explicit idle).
      // Monotonic never lowers; authoritative trusts the snapshot as truth.
      if (mode === "monotonic") continue

      const existing = current[sessionId]
      // Keep the successful snapshot distinguishable from "status has never
      // been observed".
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    if (!next && !nextInvalidated) return state
    const patch: Partial<DirectoryStore> = {}
    if (next) patch.session_status = next
    if (nextInvalidated) patch.sessionStatusInvalidated = nextInvalidated
    return patch
  })

  return changed
}

async function resyncDirectorySessionStatuses(
  host: HostRuntime,
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
  isStale?: () => boolean,
): Promise<DirectorySessionStatusSnapshot | null> {
  const invalidatedAtStart = store.getState().sessionStatusInvalidated
  const nextStatuses = await host.run(() => opencodeClient.getActiveSessionStatuses(directory))
  // null = fetch failed; preserve existing state. {} or populated = a snapshot
  // of active sessions — reconciled per `mode` (absence ≠ idle under monotonic).
  if (nextStatuses === null || isStale?.()) return null
  const currentInvalidated = store.getState().sessionStatusInvalidated
  const eligibleIds = candidateSessionIds.filter((id) => (
    !currentInvalidated?.[id] || currentInvalidated === invalidatedAtStart
  ))
  applySessionStatusSnapshot(store, nextStatuses, eligibleIds, mode)
  if (mode === "authoritative") {
    store.setState({ sessionStatusReady: true })
    host.run(() => applyGlobalSessionStatusSnapshot(directory, nextStatuses, getDirectoryOwnedSessionIds(directory, store.getState().session)))
  }
  return nextStatuses
}

/**
 * Re-check the session status shortly after an assistant message completes.
 * The turn-ending `session.idle` event can be delayed or lost; left alone, the
 * busy spinner keeps showing until the next watchdog poll tick (up to ~5s) and
 * its escalation (up to ~10s).
 *
 * The check is deferred by `MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS`, and the
 * status is read again when the timer fires: a normal turn whose `session.idle`
 * arrives inside that window settles on its own and issues no request at all.
 * Only a session the store still believes busy costs one status fetch, which
 * mirrors the watchdog escalation — the monotonic pass confirms/raises busy but
 * never lowers it, and when the snapshot reports the session idle while the
 * store still believes it busy, an authoritative resync settles the status.
 *
 * Bounded: one scheduled check per session, one in-flight status fetch per
 * directory (shared with the watchdog poll), best-effort — the watchdog poll
 * remains the backstop.
 */
export function maybePollStatusAfterMessageCompletion(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
): void {
  if (!directory || directory === "global" || !sessionID) return
  const current = store.getState().session_status?.[sessionID]
  if (!current || current.type === "idle") return

  const host = resolveHost()
  const { completionPolls: pendingMessageCompletionPolls, statusPollingDirectories } = syncHostStateOf(host)
  const pendingKey = `${directory}\u0000${sessionID}`
  if (pendingMessageCompletionPolls.has(pendingKey)) return

  const timer = setTimeout(() => {
    pendingMessageCompletionPolls.delete(pendingKey)
    const latest = store.getState().session_status?.[sessionID]
    if (!latest || latest.type === "idle") return
    if (statusPollingDirectories.has(directory)) return

    statusPollingDirectories.add(directory)
    void (async () => {
      try {
        const statuses = await runBackgroundNetworkTask(() =>
          resyncDirectorySessionStatuses(host, directory, store, [sessionID], "monotonic"), "active-session")
        if (!statuses) return
        if (needsSnapshotAfterStatusPoll(store.getState(), sessionID, statuses[sessionID])) {
          await runBackgroundNetworkTask(() =>
            resyncDirectorySessionStatuses(host, directory, store, [sessionID], "authoritative"), "active-session")
        }
      } catch {
        // Best-effort — the watchdog poll retries on its own cadence.
      } finally {
        statusPollingDirectories.delete(directory)
      }
    })()
  }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS)

  pendingMessageCompletionPolls.set(pendingKey, timer)
}

// After a monotonic poll, decide whether to escalate to a full authoritative
// resync: the store believes the session is active but the snapshot reports it
// idle/absent — a suspected missed idle that the monotonic poll deliberately
// won't lower on its own. The authoritative resync is the recovery path.
export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}

// Decide whether the event stream is genuinely stale and warrants a full
// resync. Uses stream activity that includes heartbeats, so a quiet-but-
// connected session (only receiving heartbeats) is NOT considered stale.
// A stale signal means no events at all — including no heartbeats — for the
// configured threshold, which is strong evidence the connection is dead.
// Returns false when lastStreamActivityAt is 0 (no events received yet),
// so the watchdog does not fire before the stream has delivered its first
// heartbeat.
export function shouldTriggerStaleResync(
  lastStreamActivityAt: number,
  lastFullResyncAt: number,
  now: number,
  staleThresholdMs: number = ACTIVE_SESSION_STALE_EVENT_MS,
  resyncCooldownMs: number = ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS,
): boolean {
  if (lastStreamActivityAt <= 0) return false
  if (now - lastStreamActivityAt < staleThresholdMs) return false
  if (now - lastFullResyncAt < resyncCooldownMs) return false
  return true
}

type EventRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

const SHOULD_DISPATCH_VSCODE_NOTIFICATIONS = isVSCodeRuntime()

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: SyncEvent) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
}

export const createEventRoutingIndex = (): EventRoutingIndex => ({
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
})

const normalizeEventDirectory = (rawDirectory: string): string => {
  if (!rawDirectory || rawDirectory === "global") {
    return rawDirectory
  }
  const normalized = rawDirectory.replace(/\\/g, "/").replace(/^([a-z]):/, (_, l: string) => l.toUpperCase() + ":")
  // Strip trailing slashes to match child store keys (normalizeDirectoryPath in useDirectoryStore)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

/** Part-bearing events: the store slice they touch is `part`, keyed by message. */
const isPartEvent = (type: SyncEvent["type"]): boolean => (
  type === "message.part.updated"
  || type === "message.part.delta"
  || type === "message.tool.transition"
  || type === "message.parts.replaced"
)

const setIndexedSessionDirectory = (routingIndex: EventRoutingIndex, sessionID: string, directory: string) => {
  if (!sessionID || !directory || directory === "global") {
    return
  }
  routingIndex.sessionDirectoryById.set(sessionID, directory)
}

const setIndexedSessionMessages = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  directory: string,
  messages: Message[],
) => {
  if (!sessionID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)

  const previous = routingIndex.sessionMessageIdsById.get(sessionID)
  const next = new Set<string>()

  for (const message of messages) {
    if (!message?.id) {
      continue
    }
    next.add(message.id)
    routingIndex.messageSessionById.set(message.id, sessionID)
  }

  if (previous) {
    for (const previousMessageID of previous) {
      if (!next.has(previousMessageID)) {
        routingIndex.messageSessionById.delete(previousMessageID)
      }
    }
  }

  routingIndex.sessionMessageIdsById.set(sessionID, next)
}

const setIndexedMessage = (
  routingIndex: EventRoutingIndex,
  sessionID: string,
  messageID: string,
  directory: string,
) => {
  if (!sessionID || !messageID) {
    return
  }

  setIndexedSessionDirectory(routingIndex, sessionID, directory)
  routingIndex.messageSessionById.set(messageID, sessionID)

  const existing = routingIndex.sessionMessageIdsById.get(sessionID)
  if (existing) {
    existing.add(messageID)
  } else {
    routingIndex.sessionMessageIdsById.set(sessionID, new Set([messageID]))
  }
}

const removeIndexedMessage = (
  routingIndex: EventRoutingIndex,
  messageID: string,
  sessionHint?: string | null,
) => {
  if (!messageID) {
    return
  }

  const sessionID = sessionHint ?? routingIndex.messageSessionById.get(messageID)
  routingIndex.messageSessionById.delete(messageID)

  if (!sessionID) {
    return
  }

  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (!messageIds) {
    return
  }

  messageIds.delete(messageID)
  if (messageIds.size === 0) {
    routingIndex.sessionMessageIdsById.delete(sessionID)
  }
}

const removeIndexedSession = (routingIndex: EventRoutingIndex, sessionID: string) => {
  if (!sessionID) {
    return
  }

  routingIndex.sessionDirectoryById.delete(sessionID)
  const messageIds = routingIndex.sessionMessageIdsById.get(sessionID)
  if (messageIds) {
    for (const messageID of messageIds) {
      routingIndex.messageSessionById.delete(messageID)
    }
  }
  routingIndex.sessionMessageIdsById.delete(sessionID)
}

const ingestDirectoryStateIntoRoutingIndex = (
  routingIndex: EventRoutingIndex,
  directory: string,
  state: State,
) => {
  const nextSessionIds = new Set<string>()

  for (const session of state.session) {
    if (!session?.id) {
      continue
    }
    nextSessionIds.add(session.id)
    setIndexedSessionDirectory(routingIndex, session.id, directory)
  }

  for (const sessionID of Object.keys(state.message)) {
    nextSessionIds.add(sessionID)
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
    setIndexedSessionMessages(routingIndex, sessionID, directory, state.message[sessionID] ?? EMPTY_MESSAGES)
  }

  for (const [indexedSessionID, indexedDirectory] of routingIndex.sessionDirectoryById) {
    if (indexedDirectory !== directory) {
      continue
    }
    if (!nextSessionIds.has(indexedSessionID)) {
      removeIndexedSession(routingIndex, indexedSessionID)
    }
  }
}

const findSessionInChildStores = (
  sessionID: string,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  batch?: DirectoryEventBatch,
): string | null => {
  for (const [dir, store] of childStores.children) {
    const state = getDirectoryEventState(store, batch)
    if (
      state.session.some((s) => s.id === sessionID)
      || Object.prototype.hasOwnProperty.call(state.message, sessionID)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
    ) {
      // Self-heal: populate the routing index so future events resolve instantly
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
      return dir
    }
  }
  return null
}

const childStoreHasSessionState = (
  childStores: ChildStoreManager,
  directory: string,
  sessionID: string,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  const state = getDirectoryEventState(store, batch)
  return state.session.some((session) => session.id === sessionID)
    || Object.prototype.hasOwnProperty.call(state.message, sessionID)
    || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionID)
}

const childStoreHasMessagePartState = (
  childStores: ChildStoreManager,
  directory: string,
  messageID: string,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  if (!store) return false
  return Object.prototype.hasOwnProperty.call(getDirectoryEventState(store, batch).part, messageID)
}

const getActiveDirectoryFallback = (
  host: HostRuntime,
  childStores: ChildStoreManager,
  sessionID?: string | null,
): string | null => {
  const active = getActiveSession(host)
  if (!active) return null
  if (sessionID && sessionID !== active.sessionId) return null
  return childStores.getChild(active.directory) ? active.directory : null
}

const resolveCachedSessionDirectory = (sessionID: string): string | null => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionID)
  return session ? resolveGlobalSessionDirectory(session) : null
}

const resolveDirectoryFromRoutingIndex = (
  host: HostRuntime,
  routingIndex: EventRoutingIndex,
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): string => {
  const normalizedDirectory = normalizeEventDirectory(rawDirectory)

  // A location-scoped form names the "global" sentinel, not a session: no
  // store lists it, and indexing it would file the next directory's
  // elicitation into the first one's store. Its own directory tag routes it.
  const addressedSessionID = syncEventSessionID(payload)
  const sessionID = addressedSessionID === LOCATION_SCOPED_FORM_SESSION_ID ? undefined : addressedSessionID
  if (sessionID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasSessionState(childStores, normalizedDirectory, sessionID, batch)) {
      setIndexedSessionDirectory(routingIndex, sessionID, normalizedDirectory)
      return normalizedDirectory
    }

    const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionID)
    if (indexedDirectory && childStores.getChild(indexedDirectory)) {
      return indexedDirectory
    }

    // Routing index miss — scan child stores for this session.
    // Covers optimistic sessions not yet indexed and events with wrong/empty directory.
    const found = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
    if (found) {
      return found
    }

    // Unopened directories have no store, so a session the global cache lists
    // for one of them is routed to that recorded directory. Without this, the
    // active-session and single-store fallbacks below would file another
    // project's events into whichever directory happens to be open.
    const cachedDirectory = resolveCachedSessionDirectory(sessionID)
    if (cachedDirectory) {
      return cachedDirectory
    }

    // The global stream does not always include a directory. During a session
    // transition, its routing index can lag the active session briefly; route
    // a session-addressed event only when that session is the one being viewed.
    const activeDirectory = getActiveDirectoryFallback(host, childStores, sessionID)
    if (activeDirectory) {
      return activeDirectory
    }
  }

  const messageID = syncEventMessageID(payload)
  if (messageID) {
    if (normalizedDirectory && normalizedDirectory !== "global" && childStoreHasMessagePartState(childStores, normalizedDirectory, messageID, batch)) {
      return normalizedDirectory
    }

    const sessionFromMessage = routingIndex.messageSessionById.get(messageID)
    if (sessionFromMessage) {
      const indexedDirectory = routingIndex.sessionDirectoryById.get(sessionFromMessage)
      if (indexedDirectory && childStores.getChild(indexedDirectory)) {
        return indexedDirectory
      }
    }

    // Scan child stores for a store that has parts for this message
    for (const [dir, store] of childStores.children) {
      if (Object.prototype.hasOwnProperty.call(getDirectoryEventState(store, batch).part, messageID)) {
        return dir
      }
    }

    // Some reconnect/idle gaps can deliver part events before the matching
    // message.updated event and without a sessionID. If the user is actively
    // viewing a session, route the orphaned part event there so the reducer can
    // trigger HTTP materialization instead of dropping it as a global event.
    const activeDirectory = getActiveDirectoryFallback(host, childStores)
    if (activeDirectory) {
      return activeDirectory
    }
  }

  // Single-store fallback: if there's only one directory, use it
  if (
    (addressedSessionID || messageID)
    && (!normalizedDirectory || normalizedDirectory === "global")
    && childStores.children.size === 1
  ) {
    const onlyDirectory = childStores.children.keys().next().value
    if (typeof onlyDirectory === "string" && onlyDirectory.length > 0) {
      return onlyDirectory
    }
  }

  return normalizedDirectory
}

const resolveMaterializationSessionID = (
  host: HostRuntime,
  materializationSessionID: string | undefined,
  messageID: string | undefined,
  resolvedDirectory: string,
  routingIndex: EventRoutingIndex,
): string | undefined => {
  if (materializationSessionID) return materializationSessionID
  if (messageID) {
    const indexedSessionID = routingIndex.messageSessionById.get(messageID)
    if (indexedSessionID) return indexedSessionID
  }
  const active = getActiveSession(host)
  if (resolvedDirectory && active && resolvedDirectory === active.directory) {
    return active.sessionId
  }
  return undefined
}

const updateRoutingIndexFromEvent = (
  routingIndex: EventRoutingIndex,
  directory: string,
  payload: SyncEvent,
) => {
  if (!directory || directory === "global") {
    return
  }

  const sessionID = syncEventSessionID(payload)
  if (sessionID && sessionID !== LOCATION_SCOPED_FORM_SESSION_ID) {
    setIndexedSessionDirectory(routingIndex, sessionID, directory)
  }

  switch (payload.type) {
    case "session.created":
      setIndexedSessionDirectory(routingIndex, payload.properties.info.id, directory)
      return

    case "session.deleted":
      removeIndexedSession(routingIndex, payload.properties.sessionID)
      return

    case "message.updated": {
      const { info } = payload.properties
      setIndexedMessage(routingIndex, info.sessionID, info.id, directory)
      return
    }

    case "message.removed": {
      const { sessionID, messageID } = payload.properties
      removeIndexedMessage(routingIndex, messageID, sessionID)
      return
    }

    case "message.part.updated": {
      const { part } = payload.properties
      setIndexedMessage(routingIndex, part.sessionID ?? payload.properties.sessionID, part.messageID, directory)
      return
    }

    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      setIndexedMessage(routingIndex, payload.properties.sessionID, payload.properties.messageID, directory)
      return

    default:
      return
  }
}

/**
 * Re-fetch pending forms and permissions for a directory and merge them
 * into the directory's child store, preserving any in-flight SSE updates that
 * arrived while the request was pending. Used by reconnect/materialization
 * recovery paths only; normal session switches rely on primary SSE reducer
 * state for `form.created` / `permission.asked` events. When
 * `candidateSessionIds` is omitted, every session known to the directory store
 * is treated as a candidate; when provided, recovery is limited to those IDs.
 */
export function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean },
): Promise<void> {
  return resyncHostBlockingRequests(resolveHost(), directory, store, candidateSessionIds, options)
}

async function resyncHostBlockingRequests(
  host: HostRuntime,
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean },
) {
  const pendingFormIds = toastIdsOf(pendingFormToastIds, host)
  const pendingPermissionIds = toastIdsOf(pendingPermissionToastIds, host)
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return
  const candidates = Array.from(candidateIds)

  // Re-fetch pending forms that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.form[sessionId])]),
    )
    const pendingForms = await host.run(() => opencodeClient.listPendingForms({ directories: [directory] }))
    const grouped: Record<string, FormRequest[]> = {}
    for (const form of pendingForms) {
      if (!form?.id || !form.sessionID) continue
      if (!candidateIds.has(form.sessionID)) continue
      const list = grouped[form.sessionID]
      if (list) list.push(form)
      else grouped[form.sessionID] = [form]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    for (const [sessionId, forms] of Object.entries(grouped)) {
      const knownIds = new Set((before.form[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(host, directory, sessionId)
      if (isViewed) continue
      for (const form of forms) {
        if (knownIds.has(form.id)) continue
        const toastKey = getFormToastKey(sessionId, form.id)
        if (!toastKey || pendingFormIds.has(toastKey)) continue
        pendingFormIds.add(toastKey)
        toast.info(form.title, {
          id: `form-${toastKey}`,
          description: FORM_TOAST_DESCRIPTION,
          action: formToastAction(sessionId, directory, form.id),
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.form }
      for (const [sessionId, forms] of Object.entries(grouped)) {
        merged[sessionId] = forms
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.form[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { form: merged }
    })
  } catch {
    // Non-fatal: form resync best-effort
  }

  if (options?.includePermissions === false) return

  // Re-fetch pending permissions — same rationale as forms.
  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await host.run(() => opencodeClient.listPendingPermissions({ directories: [directory] }))
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!candidateIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    if (isVSCodeRuntime()) {
      const acceptedIdsBySession = new Map<string, Set<string>>()
      await Promise.all(Object.entries(grouped).flatMap(([sessionId, permissions]) =>
        permissions.map(async (permission) => {
          if (!(await host.run(() => processVSCodeReconciledPermissionAutoAccept(permission, directory)))) return
          const accepted = acceptedIdsBySession.get(sessionId) ?? new Set<string>()
          accepted.add(permission.id)
          acceptedIdsBySession.set(sessionId, accepted)
        }),
      ))

      for (const sessionId of Object.keys(grouped)) {
        const acceptedIds = acceptedIdsBySession.get(sessionId)
        if (!acceptedIds) continue
        const remaining = (grouped[sessionId] ?? []).filter((permission) => !acceptedIds.has(permission.id))
        if (remaining.length > 0) grouped[sessionId] = remaining
        else delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(host, directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionIds,
          show: (title, options) => toast.info(title, options),
          openSession: openRequestFromToast,
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    // Non-fatal: permission resync best-effort
  }
}

export async function resyncBlockingRequestsForActiveDirectory(
  directory: string,
  childStores: ChildStoreManager,
) {
  const store = childStores.getChild(directory)
  if (!store) return
  await resyncBlockingRequestsForDirectory(directory, store)
}

async function resyncDirectoryAfterReconnect(
  host: HostRuntime,
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
  isStale: () => boolean,
) {
  if (isStale()) return
  const current = store.getState()
  const candidateSessionIds = getActiveSessionCandidateIds(host, directory, current)
  if (candidateSessionIds.length === 0) return

  await resyncDirectorySessionStatuses(host, directory, store, candidateSessionIds, "authoritative", isStale)
  if (isStale()) return

  await Promise.all(candidateSessionIds.map(async (sessionId) => {
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const loader = getImperativeSessionMessageLoader()
    const [session] = await Promise.all([
      retry(() => host.run(() => opencodeClient.getSession(sessionId, directory))).catch(() => null),
      loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT) ?? Promise.resolve(),
    ])
    if (isStale()) return
    markRecordedInterruptedTurn(store, sessionId)
    if (!session) return

    const nextSession = stripSessionDiffSnapshots(session)
    store.setState((state: DirectoryStore) => {
      const sessions = upsertSessionRecord(state.session, nextSession)
      let sessionTotal = state.sessionTotal

      if (sessions === state.session) {
        return state
      }
      if (!state.session.some((item) => item.id === nextSession.id) && !nextSession.parentID) sessionTotal += 1

      return {
        session: sessions,
        sessionTotal,
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, store.getState().message[sessionId] ?? [])
  }))

  if (isStale()) return
  await resyncHostBlockingRequests(host, directory, store, candidateSessionIds)

  if (isStale()) return
  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
}

/**
 * A deferred store that looked idle before a stream gap may own a session
 * that started a turn, or asked a permission or form, during it. OpenCode's
 * active-session list is global, so one read finds those stores without
 * reading any directory. A failed read leaves them deferred as before.
 */
async function refreshStoresActiveAfterGap(host: HostRuntime, childStores: ChildStoreManager): Promise<void> {
  const runtime = captureCatalogRuntime(host)
  const active = await host.run(() => opencodeClient.getActiveSessionStatuses())
  if (!active || !isCatalogRuntimeCurrent(runtime)) return
  childStores.refreshStaleDirectoriesWithActiveSessions(new Set(Object.keys(active)))
}

const captureCatalogRuntime = (host: HostRuntime): CatalogRuntime => ({
  host,
  sdk: host.run(() => opencodeClient.getSdkClient()),
})

const isHostRuntimeCurrent = (host: HostRuntime, runtimeKey: string): boolean => (
  host.id === runtimeKey ? hostStoresLive(host) : runtimeKey === getRuntimeKey()
)

const isCatalogRuntimeCurrent = (runtime: CatalogRuntime): boolean =>
  hostStoresLive(runtime.host) && runtime.sdk === runtime.host.run(() => opencodeClient.getSdkClient())

/**
 * OpenCode reports a catalog change (`config.updated`, `agent.updated`, ...)
 * without saying what changed, so the affected slice is re-read rather than
 * patched. Config resolves per directory, so each directory the change was
 * announced for refreshes its own copy; projects are global.
 *
 * Only those directories: a directory-scoped read makes OpenCode start that
 * location, MCP servers included, so re-reading every directory with a store
 * started every project in the sidebar the first time one of them announced
 * its catalog. A directory OpenCode names in an event is already running.
 *
 * The sync stores only hold what chat needs; the Settings lists and the
 * composer read their own stores, which `refreshStoresForCatalogKind` re-reads
 * for the same kind.
 */
async function reloadCatalog(
  kind: CatalogKind,
  childStores: ChildStoreManager,
  eventDirectories: readonly string[],
  runtime: CatalogRuntime,
): Promise<void> {
  if (!isCatalogRuntimeCurrent(runtime)) return
  const { host } = runtime
  // Before anything re-reads: a fresh GET must not be served the config the
  // client cached seconds ago.
  if (kind === "config") host.run(() => opencodeClient.clearConfigCache())

  void host.run(() => refreshStoresForCatalogKind(kind, eventDirectories))

  if (kind === "project") {
    const projects = await host.run(() => opencodeClient.listProjects()).catch(() => null)
    if (isCatalogRuntimeCurrent(runtime) && projects) {
      host.run(() => useGlobalSyncStore.getState().actions.set({ projects }))
    }
    return
  }
  // Config is the only catalog the directory stores hold. Agents, commands,
  // providers and the rest live in the stores their consumers read, which
  // `refreshStoresForCatalogKind` re-reads for the same kind.
  if (kind !== "config") return

  await Promise.all(eventDirectories.map(async (directory) => {
    const store = childStores.getChild(directory)
    if (!store) return
    if (!isCatalogRuntimeCurrent(runtime)) return
    try {
      const config = await host.run(() => opencodeClient.getConfig(directory))
      if (!isCatalogRuntimeCurrent(runtime)) return
      store.setState({ config })
      host.run(() => emitSyncConfigChanged(directory, config))
    } catch {
      // Best-effort: the next catalog event or bootstrap re-reads it.
    }
  }))
}

/**
 * One saved file makes v2 rebuild several catalogs, so the events arrive in a
 * burst. Collect the kinds and the directories they name, and re-read once the
 * burst settles; the lists are whole-slice reads, so a later event supersedes
 * an earlier one of the same kind anyway. An event without a location (a
 * credential change) re-reads the current directory.
 */
const CATALOG_RELOAD_DEBOUNCE_MS = 250

function scheduleCatalogReload(
  host: HostRuntime,
  kind: CatalogKind,
  childStores: ChildStoreManager,
  directory: string | null,
): void {
  const batch = syncHostStateOf(host).catalogReload
  const runtime = captureCatalogRuntime(host)
  host.run(() => markConfigCatalogStale(kind, directory))
  if (batch.runtime && !isCatalogRuntimeCurrent(batch.runtime)) {
    batch.directoriesByKind.clear()
    batch.currentDirectoryKinds.clear()
  }
  batch.runtime = runtime
  const directories = batch.directoriesByKind.get(kind) ?? new Set<string>()
  if (directory) directories.add(directory)
  else batch.currentDirectoryKinds.add(kind)
  batch.directoriesByKind.set(kind, directories)
  if (batch.timer) clearTimeout(batch.timer)
  batch.timer = setTimeout(() => {
    batch.timer = null
    const scheduledRuntime = batch.runtime
    batch.runtime = null
    const reloads = [...batch.directoriesByKind.entries()]
    const currentKinds = new Set(batch.currentDirectoryKinds)
    batch.directoriesByKind.clear()
    batch.currentDirectoryKinds.clear()
    if (!scheduledRuntime || !isCatalogRuntimeCurrent(scheduledRuntime)) return
    const currentDirectory = host.run(() => opencodeClient.getDirectory())
    for (const [pendingKind, pendingDirectories] of reloads) {
      if (currentKinds.has(pendingKind) && currentDirectory) pendingDirectories.add(currentDirectory)
      void reloadCatalog(pendingKind, childStores, [...pendingDirectories], scheduledRuntime)
    }
  }, CATALOG_RELOAD_DEBOUNCE_MS)
}

/**
 * OpenCode starts a location's MCP servers asynchronously and announces each
 * server's status as it settles, in the location it runs in. A status read
 * moments after the location started holds `pending` until that announcement
 * re-reads it. One re-read per directory once the burst settles.
 */
const MCP_STATUS_REFRESH_DEBOUNCE_MS = 250

function scheduleMcpStatusRefresh(host: HostRuntime, directory: string): void {
  const timers = syncHostStateOf(host).mcpStatusRefreshTimers
  const pending = timers.get(directory)
  if (pending) clearTimeout(pending)
  timers.set(directory, setTimeout(() => {
    timers.delete(directory)
    void host.run(() => useMcpStore.getState().refreshIfHeld(directory))
  }, MCP_STATUS_REFRESH_DEBOUNCE_MS))
}

// Only top-level sessions raise notifications. The directory store knows the
// parent when the directory is open; the global cache covers the rest.
const isSubtaskSession = (
  sessionID: string,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  const stored = store ? getDirectoryEventState(store, batch).session.find((s) => s.id === sessionID) : undefined
  const session = stored ?? useGlobalSessionsStore.getState().entityById.get(sessionID)
  return Boolean(session?.parentID)
}

const notifyPermissionAsked = (host: HostRuntime, permission: PermissionRequest, directory: string): void => {
  showPermissionNeededToast({
    permission,
    directory,
    isViewed: isViewedInCurrentSession(host, directory, permission.sessionID),
    pendingIds: toastIdsOf(pendingPermissionToastIds, host),
    show: (title, options) => toast.info(title, options),
    openSession: openRequestFromToast,
  })
}

/**
 * Whether the server answers this session's requests without the user: `auto`
 * always, `safety` while the safety net can run.
 */
const isAnsweredWithoutUser = (sessionID: string): boolean => {
  // Where engines own permissions nothing answers for the user, whatever an
  // older policy says (`isOpenChamberAutoAcceptActive`).
  if (!isOpenChamberAutoAcceptActive()) return false
  const mode = usePermissionStore.getState().getSessionMode(sessionID)
  return mode === "auto" || (mode === "safety" && selectSafetyNetAvailable(useRoutingStore.getState()))
}

// A request the server may answer on its own stays out of sight: no card, no
// badge, no toast, so an accepted one never flashes. It is replayed as an
// `ask` request when the server reports it left the request for the user
// (`openchamber.permission-left-for-user`: the safety net held it, Jev failed,
// or the reply did not go through), and dropped when it is answered.
const MAX_EARLY_LEFT_FOR_USER = 100

/** Whether a fresh `permission.asked` will be held back until the server rules on it. */
const isHeldUntilAutoAnswered = (host: HostRuntime, permission: PermissionRequest): boolean =>
  !syncHostStateOf(host).leftForUserBeforeAsked.has(permission.id) && !isVSCodeRuntime() && isAnsweredWithoutUser(permission.sessionID)

/** Hold `permission.asked` back until the server rules on it, when it may answer it. */
const holdBackUntilAutoAnswered = (host: HostRuntime, permission: PermissionRequest, replayAsAsk: () => void): boolean => {
  const { leftForUserBeforeAsked, permissionsAwaitingAutoAnswer } = syncHostStateOf(host)
  if (leftForUserBeforeAsked.delete(permission.id)) return false
  if (!isHeldUntilAutoAnswered(host, permission)) return false
  permissionsAwaitingAutoAnswer.set(permission.id, replayAsAsk)
  return true
}

const showPermissionLeftForUser = (
  host: HostRuntime,
  { permissionId, sessionId, directory }: Extract<SyncEvent, { type: "openchamber.permission-left-for-user" }>["properties"],
): void => {
  const { leftForUserBeforeAsked, permissionsAwaitingAutoAnswer } = syncHostStateOf(host)
  const replayAsAsk = permissionsAwaitingAutoAnswer.get(permissionId)
  if (replayAsAsk) {
    permissionsAwaitingAutoAnswer.delete(permissionId)
    replayAsAsk()
    return
  }
  // Already on screen: shown as an `ask` request, or loaded by a resync.
  if (directory && getDirectoryState(directory)?.permission[sessionId]?.some((entry) => entry.id === permissionId)) return
  leftForUserBeforeAsked.add(permissionId)
  const oldest = leftForUserBeforeAsked.values().next()
  if (leftForUserBeforeAsked.size > MAX_EARLY_LEFT_FOR_USER && !oldest.done) leftForUserBeforeAsked.delete(oldest.value)
}

const permissionReplayAsAsk = (
  host: HostRuntime,
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  streamingDirectory: string | undefined,
) => () => {
  if (!hostStoresLive(host)) return
  // The first pass kept the held request out of the cross-directory index too,
  // so the replay applies global effects and the sidebar badge appears now.
  host.run(() => handleEvent(rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, true, streamingDirectory, undefined, false))
}

const forgetAutoAnswerWait = (host: HostRuntime, permissionID: string): void => {
  const { leftForUserBeforeAsked, permissionsAwaitingAutoAnswer } = syncHostStateOf(host)
  permissionsAwaitingAutoAnswer.delete(permissionID)
  leftForUserBeforeAsked.delete(permissionID)
}

const notifyFormCreated = (host: HostRuntime, form: FormRequest, directory: string): void => {
  const sessionID = form.sessionID
  const toastKey = getFormToastKey(sessionID, form.id)
  const pendingIds = toastIdsOf(pendingFormToastIds, host)
  if (isViewedInCurrentSession(host, directory, sessionID) || !toastKey || pendingIds.has(toastKey)) return
  pendingIds.add(toastKey)
  toast.info(form.title, {
    id: `form-${toastKey}`,
    description: FORM_TOAST_DESCRIPTION,
    action: formToastAction(sessionID, directory, form.id),
  })
}

/**
 * The in-app toast a form gets, for a page an agent showed that waits for the
 * user's answer: shown while the user looks at another session, dismissed
 * once the page stops waiting. The native notification comes from the server.
 */
const notifyWaitingPage = (host: HostRuntime, event: Extract<SyncEvent, { type: "openchamber.page-waiting" | "openchamber.page-settled" }>): void => {
  if (event.type === "openchamber.page-settled") {
    toast.dismiss(`page-${event.properties.sessionID}:${event.properties.pageID}`)
    return
  }
  const { sessionID, page } = event.properties
  const directory = event.properties.directory ?? resolveCachedSessionDirectory(sessionID)
  if (!directory || isViewedInCurrentSession(host, directory, sessionID)) return
  toast.info(page.title, {
    id: `page-${sessionID}:${page.id}`,
    description: FORM_TOAST_DESCRIPTION,
    action: { label: "Open session", onClick: () => openSessionFromToast(sessionID, directory) },
  })
}

// Blocking requests in a directory without a store still deserve the in-app
// toast: the sidebar row and tray approvals need the directory store, but the
// toast only needs the request and where to open it. VS Code keeps its
// extension-host auto-accept path, which runs on the store branch only.
const notifyBlockingRequestWithoutStore = (host: HostRuntime, payload: SyncEvent, directory: string, replayAsAsk: (() => void) | null): void => {
  if (isVSCodeRuntime()) return
  if (payload.type === "permission.asked") {
    const permission = payload.properties
    if (replayAsAsk && holdBackUntilAutoAnswered(host, permission, replayAsAsk)) return
    notifyPermissionAsked(host, permission, directory)
    return
  }
  if (payload.type === "form.created") {
    notifyFormCreated(host, payload.properties.form, directory)
  }
}

const recordTurnOutcomeNotification = (
  host: HostRuntime,
  payload: Extract<SyncEvent, { type: "session.idle" | "session.error" }>,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): void => {
  const { sessionID } = payload.properties
  if (!sessionID) return
  const errorSummary = payload.type === "session.error" ? summarizeOpenCodeError(payload.properties.error) : null
  const responseBody = payload.type === "session.error" ? responseBodyOf(payload.properties.error) : null
  if (errorSummary) {
    recordSessionError({ sessionId: sessionID, directory, ...errorSummary })
  }
  if (isSubtaskSession(sessionID, directory, childStores, batch)) return
  appendNotification({
    directory,
    session: sessionID,
    time: Date.now(),
    viewed: isViewedInCurrentSession(host, directory, sessionID),
    ...(errorSummary
      ? { type: "error" as const, error: { ...errorSummary, responseBody } }
      : { type: "turn-complete" as const }),
  })
}

export function handleEvent(
  rawDirectory: string,
  payload: SyncEvent,
  childStores: ChildStoreManager,
  routingIndex: EventRoutingIndex,
  expectedRuntimeKey: string,
  // A `permission.asked` replayed because nothing answered it automatically:
  // VS Code's extension host declined it, or the server left it for the user.
  autoAnswerDeclined = false,
  streamingDirectory?: string,
  batch?: DirectoryEventBatch,
  globalEffectsAlreadyApplied = false,
) {
  const host = resolveHost()
  if (payload.type === "openchamber.notification") {
    handleUiNotificationEvent(payload.properties, normalizeEventDirectory(rawDirectory))
    return
  }

  if (payload.type === "openchamber.permission-left-for-user") {
    showPermissionLeftForUser(host, payload.properties)
    return
  }

  // A page that waits for the user's answer lives only in the cross-directory
  // index: no directory store holds it, since OpenCode never hears of the wait.
  if (payload.type === "openchamber.page-waiting" || payload.type === "openchamber.page-settled") {
    if (!isHostRuntimeCurrent(host, expectedRuntimeKey)) return
    applyWaitingPageEvent(payload, resolveCachedSessionDirectory)
    notifyWaitingPage(host, payload)
    return
  }

  if (payload.type === "openchamber.permission-auto-accept") {
    usePermissionStore.getState().applySnapshot(policySnapshotFromWire(payload.properties), expectedRuntimeKey)
    return
  }

  if (shouldConsumeBulkArchiveEcho(payload, expectedRuntimeKey)) return

  const routedAsUnlocatedForm = routeUnlocatedLocationScopedForm(normalizeEventDirectory(rawDirectory), payload, {
    stores: Array.from(childStores.children, ([dir, store]) => [dir, getDirectoryEventState(store, batch)] as const),
    activeDirectory: opencodeClient.getDirectory(),
    redirect: (dir) => handleEvent(dir, payload, childStores, routingIndex, expectedRuntimeKey, false, streamingDirectory, batch),
    resync: (dir) => {
      const store = childStores.getChild(dir)
      if (store) void resyncHostBlockingRequests(host, dir, store, [LOCATION_SCOPED_FORM_SESSION_ID], { includePermissions: false })
    },
  })
  if (routedAsUnlocatedForm) return

  const directory = resolveDirectoryFromRoutingIndex(host, routingIndex, rawDirectory, payload, childStores, batch)

  // OpenCode dropped this directory's in-memory services (an hour idle, or an
  // explicit reload). Session records and messages live in its database and
  // stay valid; what went away is the live state read from that graph, so the
  // directory the user is looking at is bootstrapped again from scratch. The
  // pending permissions and forms it rejected on the way out, and the turns it
  // interrupted, arrive as their own events. Background directories are left
  // alone on purpose: re-reading them would recreate the services OpenCode
  // just evicted and turn every idle directory into an hourly refresh loop;
  // they are re-read when selected or on the next reconnect.
  if (payload.type === "location.shutdown") {
    if (
      directory
      && directory !== "global"
      && isHostRuntimeCurrent(host, expectedRuntimeKey)
      && directory === opencodeClient.getDirectory()
      && childStores.getChild(directory)
    ) {
      childStores.requestBootstrap({ directory, priority: "selected", reason: "location-shutdown", force: true })
    }
    return
  }

  if (payload.type === "session.patched") {
    noteForkedSessionPatched(payload.properties.sessionID)
  }

  if (payload.type === "session.forked") {
    void applyForkedSession(
      {
        sessionID: payload.properties.sessionID,
        parentID: payload.properties.parentID,
        directory: directory && directory !== "global" ? directory : undefined,
      },
      {
        isKnown: (sessionID) => host.run(() => useGlobalSessionsStore.getState().entityById.has(sessionID)),
        isCreatingLocally: (parentID) => useBtwStore.getState().byParent[parentID]?.creating === true,
        getSession: (sessionID, sessionDirectory) => host.run(() => opencodeClient.getSession(sessionID, sessionDirectory)),
        isCurrent: () => isHostRuntimeCurrent(host, expectedRuntimeKey),
        apply: (info) => host.run(() => handleEvent(
          rawDirectory,
          { type: "session.created", properties: { info } },
          childStores,
          routingIndex,
          expectedRuntimeKey,
        )),
      },
    )
    return
  }

  if (payload.type === "session.deleted" && isHostRuntimeCurrent(host, expectedRuntimeKey)) {
    const sessionID = syncEventSessionID(payload)
    if (sessionID && directory && directory !== "global") {
      cleanupPersistedSessionState({ runtimeKey: expectedRuntimeKey, directory, sessionId: sessionID })
    }
  }

  if (!globalEffectsAlreadyApplied) {
    // A request the server may answer on its own stays out of the
    // cross-directory index as well, or collapsed rows, the tray and run
    // overviews would flash a shield for a request that is then auto-approved.
    // It enters the index when it is replayed for the user.
    const heldForAutoAnswer = payload.type === "permission.asked"
      && !autoAnswerDeclined
      && isHeldUntilAutoAnswered(host, payload.properties)
    if (batch) {
      batch.globalSessionEvents.push(payload)
      if (!heldForAutoAnswer) {
        const statusEvents = batch.globalStatusEventsByDirectory.get(directory)
        if (statusEvents) statusEvents.push(payload)
        else batch.globalStatusEventsByDirectory.set(directory, [payload])
      }
    } else {
      applySessionEventToGlobalSessions(payload)
      // Child stores remain the primary source for synced directories; these
      // indexes cover unopened directories and list/status races.
      applyBackgroundShellEvents(directory, [payload])
      applyGlobalSessionStatusEvent(directory, payload)
      if (!heldForAutoAnswer) applyGlobalBlockingRequestEvents(directory, [payload])
    }
  }

  // Turn-complete and error notifications are recorded before the directory
  // store lookup. Unopened directories are never bootstrapped and have no
  // store, yet their collapsed sidebar rows still need the unread dot.
  if ((payload.type === "session.idle" || payload.type === "session.error") && directory && directory !== "global") {
    recordTurnOutcomeNotification(host, payload, directory, childStores, batch)
  }

  // Global events
  if (directory === "global" || !directory) {
    const recent = isRecentBoot(host)
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      // Suppress refresh during/shortly after bootstrap
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "catalog") {
      scheduleCatalogReload(host, result.kind, childStores, null)
    }
    if (payload.type === "server.connected") {
      // OpenCode answers for the first time, boot window or not: directory
      // bootstraps that failed while it was starting get their one retry.
      if (isHostRuntimeCurrent(host, expectedRuntimeKey) && claimFirstServerConnect(childStores, expectedRuntimeKey)) {
        childStores.retryFailedBootstraps()
        notifyFirstServerConnect(expectedRuntimeKey)
      }
      // OpenCode's stream restarted outside the boot window: events were lost.
      // Stores in use re-read now; the rest re-read when used again.
      if (!recent) {
        getImperativeSessionMessageLoader()?.markHistoryStale()
        const refreshing = childStores.refreshAfterStreamRestart(opencodeClient.getDirectory())
        // Bootstrap re-reads the commands of the directories it refreshes; a
        // command in any other directory may have exited during the gap.
        for (const dir of directoriesWithRunningShells()) {
          if (refreshing.has(normalizePath(dir) ?? dir)) continue
          void runBackgroundNetworkTask(() => refreshBackgroundShells(dir, (target) => opencodeClient.listRunningShells(target)))
            .catch(() => undefined)
        }
        void refreshStoresActiveAfterGap(host, childStores)
      }
    }
    return
  }

  // Directory events
  let store = childStores.getChild(directory)
  let resolvedDirectory = directory

  if (!store) {
    // Store not found for this directory — attempt recovery by scanning
    // child stores for the session. This handles directory mismatches
    // (trailing slashes, case differences, events with wrong directory).
    const sessionID = syncEventSessionID(payload)
    if (sessionID) {
      const fallbackDir = findSessionInChildStores(sessionID, childStores, routingIndex, batch)
      if (fallbackDir) {
        store = childStores.getChild(fallbackDir)
        resolvedDirectory = fallbackDir
      }
    }
  }

  if (payload.type === "permission.replied" && payload.properties.requestID) {
    forgetAutoAnswerWait(host, payload.properties.requestID)
  }

  if (!store) {
    if (payload.type === "session.revert.committed") {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID: payload.properties.sessionID })
    }
    const replayAsAsk = payload.type === "permission.asked" && !autoAnswerDeclined
      ? permissionReplayAsAsk(host, rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, streamingDirectory)
      : null
    notifyBlockingRequestWithoutStore(host, payload, directory, replayAsAsk)
    if (payload.type === "mcp.status.changed") scheduleMcpStatusRefresh(host, directory)
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "catalog") {
      scheduleCatalogReload(host, result.kind, childStores, directory)
    }
    return
  }

  childStores.mark(resolvedDirectory)

  if (payload.type === "permission.asked") {
    const permission: PermissionRequest = payload.properties
    if (isVSCodeRuntime() && !autoAnswerDeclined && isOpenChamberAutoAcceptActive()) {
      const eventKey = getVSCodePermissionEventKey(host.id, resolvedDirectory, permission.sessionID, permission.id)
      const eventToken = Symbol(eventKey ?? permission.id)
      if (eventKey) pendingVSCodePermissionEvents.set(eventKey, eventToken)
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      const completePermissionCheck = (accepted: boolean) => {
        if (eventKey && pendingVSCodePermissionEvents.get(eventKey) !== eventToken) return
        if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
        if (!hostStoresLive(host)) return
        if (!accepted) host.run(() => handleEvent(
          rawDirectory,
          payload,
          childStores,
          routingIndex,
          expectedRuntimeKey,
          true,
          streamingDirectory,
          undefined,
          true,
        ))
      }
      void processVSCodePermissionAutoAccept(permission, resolvedDirectory).then(
        completePermissionCheck,
        () => completePermissionCheck(false),
      )
      return
    }
    if (!autoAnswerDeclined && holdBackUntilAutoAnswered(
      host,
      permission,
      permissionReplayAsAsk(host, rawDirectory, payload, childStores, routingIndex, expectedRuntimeKey, streamingDirectory),
    )) {
      updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)
      return
    }

    notifyPermissionAsked(host, permission, resolvedDirectory)
  }

  if (payload.type === "permission.replied") {
    const { sessionID, requestID } = payload.properties
    // A request the routing safety net was holding is settled either way.
    if (requestID) useRoutingStore.getState().releasePermission(requestID)
    const toastKey = getPermissionToastKey(sessionID, requestID)
    const eventKey = getVSCodePermissionEventKey(host.id, resolvedDirectory, sessionID, requestID)
    if (eventKey) pendingVSCodePermissionEvents.delete(eventKey)
    if (toastKey) {
      toastIdsOf(pendingPermissionToastIds, host).delete(toastKey)
      toast.dismiss(`permission-${toastKey}`)
    }
  }

  if (payload.type === "form.created") {
    notifyFormCreated(host, payload.properties.form, resolvedDirectory)
  }

  if (payload.type === "form.settled") {
    const { sessionID, formID } = payload.properties
    const toastKey = getFormToastKey(sessionID, formID)
    if (toastKey) {
      toastIdsOf(pendingFormToastIds, host).delete(toastKey)
      toast.dismiss(`form-${toastKey}`)
    }
  }

  // Sync-layer parent resync: when a child session goes idle, recover
  // the parent session snapshot. This ensures the
  // parent's task tool part reflects the child's completion even when
  // no ToolPart component is mounted.
  if (payload.type === "session.idle") {
    const idleSessionId = payload.properties.sessionID
    if (idleSessionId && resolvedDirectory && resolvedDirectory !== "global") {
      const sessionState = getDirectoryEventState(store, batch)
      const parentID = sessionState.session.find((s) => s.id === idleSessionId)?.parentID
      if (parentID) {
        enqueueSessionMaterialization(host, resolvedDirectory, parentID, childStores, { reason: "child-session-idle" })
      }
    }
  }

  // Read live state, create targeted draft cloning ONLY fields that event
  // type will mutate. This preserves reference identity for untouched slices
  // so Zustand selectors skip re-renders for unrelated subscribers.
  const current = getDirectoryEventState(store, batch)
  // OpenCode v2 settles a live tool through `message.tool.transition`; a full
  // `message.part.updated` arrives only for snapshots. Both can finish a tool.
  const toolPartRef = payload.type === "message.part.updated"
    ? { messageID: payload.properties.part.messageID, partID: payload.properties.part.id }
    : payload.type === "message.tool.transition"
      ? { messageID: payload.properties.messageID, partID: payload.properties.partID }
      : undefined
  const previousPart = toolPartRef
    ? current.part[toolPartRef.messageID]?.find((part) => part.id === toolPartRef.partID)
    : undefined
  // Only `session.moved` patches a directory; read the old one before the reducer rewrites it.
  const directoryBeforePatch = payload.type === "session.patched" && payload.properties.patch.directory !== undefined
    ? current.session.find((session) => session.id === payload.properties.sessionID)?.directory
    : undefined
  let sessionMove: SessionMove | null = null
  const draft: State = { ...current }
  const clonedFields = batch?.clonedFields.get(store) ?? new Set<keyof State>()
  const newlyClonedFields: Array<keyof State> = []
  const cloneField = <K extends keyof State>(field: K, clone: (value: State[K]) => State[K]) => {
    if (clonedFields.has(field)) return
    Object.assign(draft, { [field]: clone(current[field]) })
    newlyClonedFields.push(field)
  }

  switch (payload.type) {
    case "session.created":
    case "session.patched":
    case "session.deleted":
      cloneField("session", (value) => [...value])
      cloneField("permission", (value) => ({ ...value }))
      cloneField("form", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      cloneField("sessionEventRevision", (value) => ({ ...(value ?? {}) }))
      cloneField("sessionDeletedRevision", (value) => ({ ...(value ?? {}) }))
      break
    case "session.status":
    case "session.idle":
    case "session.error":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("session_status", (value) => ({ ...(value ?? {}) }))
      break
    case "message.updated":
    case "message.patched":
    case "message.compaction.delta":
      cloneField("message", (value) => ({ ...value }))
      break
    case "message.removed":
      cloneField("message", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      break
    case "session.revert.committed":
      cloneField("session", (value) => [...value])
      cloneField("message", (value) => ({ ...value }))
      cloneField("part", (value) => ({ ...value }))
      break
    case "message.part.updated":
    case "message.part.delta":
    case "message.tool.transition":
    case "message.parts.replaced":
      cloneField("part", (value) => ({ ...value }))
      break
    case "vcs.branch.updated":
      break
    case "permission.asked":
    case "permission.replied":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("permission", (value) => ({ ...value }))
      break
    case "form.created":
    case "form.settled":
      recordDirectoryRecoveryEvent(store, payload)
      cloneField("form", (value) => ({ ...value }))
      break
    default:
      break
  }

  countSyncPerformance("reducerEvents")
  // A catalog event names the location it was rebuilt in; for an open
  // directory it lands here rather than in the global branch above.
  const reducerResult = applyDirectoryEvent(draft, payload, {
    onCatalogUpdated: (kind) => scheduleCatalogReload(host, kind, childStores, resolvedDirectory),
    onLoadMcp: () => scheduleMcpStatusRefresh(host, resolvedDirectory),
  })
  const reducerChanged = typeof reducerResult === "boolean" ? reducerResult : reducerResult.changed
  const materializationResult = typeof reducerResult === "boolean" ? undefined : reducerResult.materialization
  // Retire old reads even if a local send already removed the reverted range.
  // Only optimistic messages surviving the reducer may enter the next fetch.
  if (payload.type === "session.revert.committed") {
    const { sessionID } = payload.properties
    getImperativeSessionMessageLoader()?.invalidateSession(
      { directory: resolvedDirectory, sessionID }, draft.message[sessionID] ?? [],
    )
  }
  if (reducerChanged && (payload.type === "session.patched" || payload.type === "session.deleted")) {
    recordDirectoryRecoveryEvent(store, payload)
  }

  const updatedPart = reducerChanged && toolPartRef
    ? draft.part[toolPartRef.messageID]?.find((part) => part.id === toolPartRef.partID)
    : undefined
  if (updatedPart) {
    sessionEvents.requestGitRefreshForToolTransition(resolvedDirectory, previousPart, updatedPart)
    fileTreeChanges.toolTransition(resolvedDirectory, previousPart, updatedPart)
  }
  if (payload.type === "message.patched" && payload.properties.patch.time?.completed !== undefined) {
    const { sessionID, patch } = payload.properties
    // A replayed shell completion changes nothing and announces nothing.
    if (patch.shell) {
      if (reducerChanged) fileTreeChanges.unknownChange(resolvedDirectory)
    } else if (patch.finish !== undefined) {
      fileTreeChanges.stepCompleted(resolvedDirectory, sessionID, patch.snapshot?.files)
    }
  }

  if (reducerChanged) {
    countSyncPerformance("reducerChangedEvents")
    const eventSessionID = syncEventSessionID(payload)
    const eventMessageID = syncEventMessageID(payload)
    if (isPartEvent(payload.type) && eventMessageID) {
      const partSessionID = eventSessionID ?? routingIndex.messageSessionById.get(eventMessageID)
      if (partSessionID) markDirectorySessionPartChanged(store, partSessionID, eventMessageID)
    }
    if (batch) {
      batch.states.set(store, draft as DirectoryStore)
      batch.changedStores.add(store)
      if (newlyClonedFields.length > 0) {
        newlyClonedFields.forEach((field) => clonedFields.add(field))
        batch.clonedFields.set(store, clonedFields)
      }
    } else {
      countSyncPerformance("directoryStorePublications")
      store.setState(draft)
    }
    // The session moved to another directory: the chat reads and sends there
    // from now on, so its messages and live state follow it.
    const destinationDirectory = payload.type === "session.patched" ? payload.properties.patch.directory : undefined
    if (
      eventSessionID
      && destinationDirectory
      && directoryBeforePatch
      && normalizeEventDirectory(destinationDirectory) !== normalizeEventDirectory(directoryBeforePatch)
      && isHostRuntimeCurrent(host, expectedRuntimeKey)
    ) {
      sessionMove = { sessionID: eventSessionID, from: resolvedDirectory, to: destinationDirectory }
    }
    const sessionID = eventSessionID
    const messageID = eventMessageID
    if (
      isPartEvent(payload.type)
      && normalizeEventDirectory(resolvedDirectory) === normalizeEventDirectory(streamingDirectory ?? "")
    ) {
      const heartbeatSessionID = sessionID ?? (messageID ? routingIndex.messageSessionById.get(messageID) : undefined)
      if (heartbeatSessionID) touchStreamingSession(heartbeatSessionID)
    }
    const archived = payload.type === "session.patched"
      && Boolean(payload.properties.patch.time?.archived)
    if (sessionID && (payload.type === "session.deleted" || archived)) {
      getImperativeSessionMessageLoader()?.invalidateSession({ directory: resolvedDirectory, sessionID })
    }
    syncDebug.dispatch.eventApplied(payload.type, sessionID, messageID)

    // Snapshot materialization on message.updated: if the message was inserted or
    // replaced but draft.part[messageID] is empty, the parts were lost or
    // never arrived. Recover the session so the UI doesn't render a blank bubble.
    if (sessionID && messageID && payload.type === "message.updated") {
      const after = getDirectoryEventState(store, batch)
      const { info } = payload.properties
      if (info.role === "assistant" && !Object.prototype.hasOwnProperty.call(after.part, messageID)) {
        enqueueSessionMaterialization(host, resolvedDirectory, sessionID, childStores, {
          reason: "empty-assistant-message",
          messageID,
        })
      }
      // An assistant message that finished is strong evidence the turn may
      // have ended; if the session.idle event was delayed or lost, settle the
      // busy status immediately instead of waiting for the next watchdog poll.
      if (info.role === "assistant" && typeof info.time.completed === "number") {
        maybePollStatusAfterMessageCompletion(resolvedDirectory, store, sessionID)
      }
    }
  } else {
    const sessionID = syncEventSessionID(payload)
    const messageID = syncEventMessageID(payload)
    syncDebug.dispatch.eventNoChange(payload.type, sessionID, messageID)

  }

  // Snapshot materialization is driven by typed reducer outcomes, not by
  // inferring meaning from a generic false/no-change result.
  if (materializationResult) {
    const materializationSessionID = resolveMaterializationSessionID(
      host,
      materializationResult.sessionID ?? syncEventSessionID(payload),
      materializationResult.messageID ?? syncEventMessageID(payload),
      resolvedDirectory,
      routingIndex,
    )
    if (materializationSessionID) {
      enqueueSessionMaterialization(host, resolvedDirectory, materializationSessionID, childStores, {
        reason: materializationResult.reason,
        messageID: materializationResult.messageID,
        partID: materializationResult.partID,
      })
    }
  }

  if (payload.type === "session.idle" || payload.type === "session.error") {
    const sessionID = syncEventSessionID(payload)
    const state = getDirectoryEventState(store, batch)
    const messageID = sessionID ? getStaleRunningToolMessageID(state, sessionID) : undefined
    if (sessionID && messageID) {
      enqueueSessionMaterialization(host, resolvedDirectory, sessionID, childStores, {
        reason: "settled-running-tool",
        messageID,
      })
    }
    // OpenCode said the turn stopped or failed: finalize the open message and
    // orphaned tools through the same batch. A plain idle says nothing about
    // how the turn ended, so it leaves the message as OpenCode stored it.
    const stopped = payload.type === "session.error" || payload.properties.outcome === "interrupted"
    if (sessionID && stopped) {
      const failure = payload.type === "session.error" ? payload.properties.error : undefined
      const interrupted = interruptedTurnToolParts(state, sessionID, Date.now(), failure)
      if (interrupted) {
        cloneField("message", (value) => ({ ...value }))
        draft.message[sessionID] = interrupted.messages
        if (interrupted.parts) {
          cloneField("part", (value) => ({ ...(value ?? {}) }))
          draft.part[interrupted.messageID] = interrupted.parts
        }
        if (batch) {
          batch.states.set(store, draft as DirectoryStore)
          batch.changedStores.add(store)
        } else {
          const currentState = store.getState()
          if (interrupted.parts) {
            store.setState({
              message: { ...currentState.message, [sessionID]: interrupted.messages },
              part: { ...currentState.part, [interrupted.messageID]: interrupted.parts },
            })
          } else {
            store.setState({
              message: { ...currentState.message, [sessionID]: interrupted.messages },
            })
          }
        }
      }
    }
  }

  updateRoutingIndexFromEvent(routingIndex, resolvedDirectory, payload)

  // After the routing index update above, which still files the session under
  // the source; the move re-registers it under the destination.
  if (sessionMove) {
    if (batch) batch.sessionMoves.push(sessionMove)
    else adoptSessionMove(sessionMove.sessionID, sessionMove.from, sessionMove.to)
  }
}

// ---------------------------------------------------------------------------
// Interrupted-turn reconciliation
//
// When OpenCode stops or fails a turn it says so: the live
// `session.execution.interrupted`/`failed` event, and the `idle` record it
// appends to the session's history with the same outcome. That explicit
// record is the only thing that marks a turn stopped here. The server does
// not always finalize the trailing assistant message and its tool parts
// before the record (anomalyco/opencode#19023), so the record's turn is
// completed locally (`closedLocally`) and its orphaned tools become
// `error`/`Interrupted` with an end time — the same shape OpenCode itself
// writes for cancelled tools. The message carries the error OpenCode reported
// for a failed turn; `aborted` only when the turn was stopped or the failure
// came without one. A later terminal event can supersede the mark;
// a stale refresh cannot regress the locally final state.
//
// An idle status, a status snapshot that no longer lists a session, or an
// unfinished message alone never marks a turn: a turn run by another
// OpenCode process on the same database (the TUI, `opencode run`) looks
// exactly like that while it is still going (#4156).
export function interruptedTurnToolParts(
  state: DirectoryStore,
  sessionID: string,
  now = Date.now(),
  failure?: StructuredError,
): { messageID: string; messages: Message[]; parts?: Part[] } | null {
  if ((state.form?.[sessionID] ?? []).length > 0) return null
  if ((state.permission?.[sessionID] ?? []).length > 0) return null
  // A session that is running again belongs to its new turn.
  const status = state.session_status?.[sessionID]
  if (status && status.type !== "idle") return null

  const messages = state.message[sessionID] ?? []
  let messageIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role === "user") return null
    if (candidate.role !== "assistant") continue
    messageIndex = index
    break
  }
  if (messageIndex < 0) return null

  const message = messages[messageIndex]
  if (message.role !== "assistant") return null
  if (message.time.completed !== undefined) {
    // The turn finished; a missed terminal tool event is the tail refresh's
    // job, not an interruption.
    return null
  }

  const messageID = message.id
  const nextMessages = [...messages]
  const error: StructuredError = failure ?? { type: "aborted", message: "aborted" }
  nextMessages[messageIndex] = {
    ...message,
    time: { ...message.time, completed: now },
    error,
    closedLocally: true,
  }

  let partsChanged = false
  const currentParts = state.part[messageID]
  const nextParts = currentParts?.map((part) => {
    if (part.type !== "tool") return part
    if (part.state.status !== "pending" && part.state.status !== "running") return part
    partsChanged = true
    const start = part.state.status === "running" ? part.state.time.start : now
    return {
      ...part,
      state: {
        ...part.state,
        status: "error" as const,
        error: "Interrupted",
        time: { start, end: now },
      },
    }
  })

  return {
    messageID,
    messages: nextMessages,
    parts: partsChanged ? nextParts : undefined,
  }
}

/**
 * How OpenCode recorded the end of the trailing assistant turn: the newest
 * `idle` record after that turn's assistant message, with the error of a
 * failed turn (2.0.27+), or undefined while no process has recorded its end.
 */
function recordedTurnEnd(
  state: DirectoryStore,
  sessionID: string,
): { outcome: SessionOutcome; error?: StructuredError } | undefined {
  const messages = state.message[sessionID] ?? []
  let end: { outcome: SessionOutcome; error?: StructuredError } | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return undefined
    if (message.role === "assistant") return end
    if (message.role === "idle") end ??= { outcome: message.outcome, error: message.error }
  }
  return undefined
}

/**
 * Marks the trailing turn of a freshly loaded session stopped when its history
 * records that OpenCode interrupted or failed it. Any other history, including
 * an unfinished answer with no record after it, is left as OpenCode stored it.
 */
export function markRecordedInterruptedTurn(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const state = store.getState()
  const end = recordedTurnEnd(state, sessionID)
  if (end?.outcome !== "interrupted" && end?.outcome !== "failed") return
  const interrupted = interruptedTurnToolParts(state, sessionID, Date.now(), end.outcome === "failed" ? end.error : undefined)
  if (!interrupted) return

  const interruptedParts = interrupted.parts
  if (!interruptedParts) {
    store.setState((current) => ({
      message: { ...current.message, [sessionID]: interrupted.messages },
    }))
    return
  }

  store.setState((current) => ({
    message: { ...current.message, [sessionID]: interrupted.messages },
    part: { ...current.part, [interrupted.messageID]: interruptedParts },
  }))
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** One session-list page through the shared client wrapper. */
const listSessionPageOn = (host: HostRuntime): SessionPageLister => (options) => host.run(() => opencodeClient.listSessionsPage(options))

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

/**
 * Moves the open chat of a space among `goneIds` to the directory the global list holds for it,
 * the archive's. Answers whether there is nothing more to do: the chat moved, or the open chat
 * is not one of those spaces' any more. False while the global list does not name the
 * directory yet.
 */
const followCurrentChatToArchive = (goneIds: ReadonlySet<string>): boolean => {
  const ui = useSessionUIStore.getState()
  const current = normalizePath(ui.currentSessionDirectory)
  const spaceId = spaceIdOfDirectory(current)
  if (!ui.currentSessionId || spaceId === null || !goneIds.has(spaceId)) return true
  const archived = normalizePath(useGlobalSessionsStore.getState().entityById.get(ui.currentSessionId)?.directory)
  if (!archived || archived === current) return false
  ui.setSessionDirectory(ui.currentSessionId, archived)
  return true
}

type HostSyncParts = {
  childStores: ChildStoreManager
  messageLoader: SessionMessageLoader
  routingIndex: EventRoutingIndex
  directory: { current: string }
  directoryListeners: Set<() => void>
  currentDirectory: CurrentDirectorySource
  disposalTimer: { current: ReturnType<typeof setTimeout> | null }
}

type HostSyncEngineInput = {
  host: HostRuntime
  runtimeKey: string
  sdk: OpenCodeClient
  client: OpencodeService
  parts: HostSyncParts
  directory: string
  policy: HostSyncPolicy
}

const createHostSyncParts = (
  runtimeKey: string,
  client: OpencodeService,
  seedsSessions: (directory: string) => boolean,
  directory: string,
): HostSyncParts => {
  const childStores = new ChildStoreManager({ runtimeKey, seedsSessions })
  const directoryRef = { current: directory }
  const directoryListeners = new Set<() => void>()
  return {
    childStores,
    messageLoader: new SessionMessageLoader(childStores, { sdk: client, runtimeKey }, openCodeStartupSignal),
    routingIndex: createEventRoutingIndex(),
    directory: directoryRef,
    directoryListeners,
    currentDirectory: {
      get: () => directoryRef.current,
      subscribe: (notify) => {
        directoryListeners.add(notify)
        return () => directoryListeners.delete(notify)
      },
    },
    disposalTimer: { current: null },
  }
}

function useHostSyncEngine({ host, runtimeKey, sdk, client, parts, directory, policy }: HostSyncEngineInput): void {
  // Capacitor apps were previously locked to SSE because Android WebSocket
  // upgrades appeared broken. Root cause was server-side: the Android WebView
  // origin (https://localhost, androidScheme 'https') was missing from the
  // packaged-client origin allowlist, so every WS upgrade was rejected with
  // 403. With the origin allowlisted, mobile uses the same transport
  // selection as everywhere else ('auto' falls back to SSE on WS failure).
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const { childStores, messageLoader, routingIndex, directoryListeners } = parts
  const currentDirectoryRef = parts.directory
  const messageLoaderDisposalTimerRef = parts.disposalTimer
  messageLoader.configure({ sdk: client, runtimeKey })
  // Asked while the rest of the bootstrap loads, so the first session page
  // already arrives with its tool results shelled.
  useEffect(() => {
    client.learnMessagePageShellsSupport()
  }, [client, runtimeKey])
  currentDirectoryRef.current = directory
  // Written during render (above) so children rendering in the same pass read
  // the new directory; subscribers are notified after commit.
  React.useLayoutEffect(() => {
    for (const notify of directoryListeners) notify()
  }, [directory, directoryListeners])
  const policyRef = useRef(policy)
  policyRef.current = policy
  const locationReleaseRef = useRef<LocationRelease | null>(null)
  const previousDirectoryRef = useRef(directory)
  useEffect(() => {
    const sdkEpoch = client.getSdkClient()
    const release = createRealLocationRelease({
      releaseDelayMs: (directory) => {
        if (isChatDirectoryPath(directory)) return CHAT_LOCATION_RELEASE_DELAY_MS
        if (isWorktreeDirectory(directory, host.run(() => useSessionUIStore.getState().availableWorktreesByProject))) {
          return WORKTREE_LOCATION_RELEASE_DELAY_MS
        }
        return null
      },
      isCurrentDirectory: (directory) => directory === currentDirectoryRef.current,
      directoryUse: (directory) => isDirectoryExternallyViewed(host, directory)
        ? "busy"
        : directoryUse(directory, childStores.getChild(directory)?.getState()),
      release: async (directory) => {
        if (!isHostRuntimeCurrent(host, runtimeKey) || client.getSdkClient() !== sdkEpoch) return
        await client.releaseLocation(directory)
      },
    })
    locationReleaseRef.current = release
    return () => {
      release.dispose()
      if (locationReleaseRef.current === release) locationReleaseRef.current = null
    }
  }, [childStores, client, currentDirectoryRef, host, runtimeKey, sdk])
  useEffect(() => {
    const previous = previousDirectoryRef.current
    previousDirectoryRef.current = directory
    locationReleaseRef.current?.directoryChanged(previous, directory)
  }, [directory])
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const lastChildDiscoveryAtByDirectoryRef = useRef(new Map<string, number>())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const blockingRequestResyncingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)

  const triggerDirectoryResync = useCallback((directory: string, reason: SessionMaterializationReason) => {
    const store = childStores.children.get(directory)
    if (!store) return
    const resyncing = resyncingDirectoriesRef.current
    if (resyncing.has(directory)) return

    lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    resyncing.add(directory)
    const sdkEpoch = client.getSdkClient()
    const isStale = () => !isHostRuntimeCurrent(host, runtimeKey)
      || client.getSdkClient() !== sdkEpoch || childStores.children.get(directory) !== store
    void resyncDirectoryAfterReconnect(host, directory, store, routingIndex, reason, isStale)
      .catch(() => {
        // Transient failure — the watchdog, next SSE event, or reconnect will catch up.
      })
      .finally(() => {
        resyncing.delete(directory)
      })
  }, [childStores, client, host, routingIndex, runtimeKey])

  useEffect(() => {
    if (typeof window === "undefined") return

    const onSystemResume = () => {
      const directory = currentDirectoryRef.current
      if (!directory || !childStores.getChild(directory)) return

      const resyncing = blockingRequestResyncingDirectoriesRef.current
      if (resyncing.has(directory)) return
      resyncing.add(directory)
      void host.run(() => resyncBlockingRequestsForActiveDirectory(directory, childStores))
        .finally(() => resyncing.delete(directory))
    }

    window.addEventListener("openchamber:system-resume", onSystemResume)
    return () => window.removeEventListener("openchamber:system-resume", onSystemResume)
  }, [childStores, currentDirectoryRef, host])

  // Configure child store manager
  useEffect(() => host.run(() => {
    void usePermissionStore.getState().hydrate().catch(() => undefined)
    // Whether this server's engines own permissions, which retires the shield.
    void useEngineControlsStore.getState().load()
    void useMessageQueueStore.getState().hydrate().catch(() => undefined)
  }), [host, sdk])

  useEffect(() => {
    const sdkEpoch = client.getSdkClient()
    return childStores.configure({
      bootstrapConcurrency: 2,
      isCurrentScope: () => isHostRuntimeCurrent(host, runtimeKey) && client.getSdkClient() === sdkEpoch,
      onBootstrap: async (context: DirectoryBootstrapContext) => {
        const { directory } = context
        const isCurrent = context.isCurrent
        const store = childStores.getChild(directory)
        if (!store || !isCurrent()) return

        const failBootstrap = async () => {
          if (!isCurrent()) return
          // Only the owning filesystem API can establish an OS permission
          // failure; OpenCode/proxy text is not permission evidence.
          const files = getRegisteredRuntimeAPIs()?.files
          if (files) {
            try {
              await host.run(() => files.listDirectory(directory))
            } catch (error) {
              if (isFilesystemError(error) && error.reason === "os-permission") throw error
            }
          }
          throw new Error(`Directory bootstrap failed for ${directory}`)
        }
        const runBootstrap = async (): Promise<"complete" | "failed" | "stale"> => {
          if (!isCurrent()) return "stale"
          const globalState = host.run(() => useGlobalSyncStore.getState())
          const bootstrap = host.run(() => bootstrapDirectory({
            directory,
            store,
            set: (patch) => {
              if (!isCurrent()) return
              store.setState(patch)
              if (patch.session_status) {
                const sessionStatus = patch.session_status
                host.run(() => applyGlobalSessionStatusSnapshot(directory, sessionStatus, getDirectoryOwnedSessionIds(directory, store.getState().session)))
              }
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            isStale: () => !isCurrent(),
            global: {
              config: globalState.config,
              projects: globalState.projects,
              path: globalState.path,
            },
            // Each page owns its bounded retry. Replaying the whole list here
            // multiplies attempts and holds a bootstrap slot behind failures.
            loadSessions: async (dir) => {
              if (!isCurrent()) return
              const baselineRevision = store.getState().sessionRevision ?? 0
              // One list covers the directory: v2 has no roots or archived
              // filter, so roots and child sessions (sub-agent delegations)
              // arrive together and are split here. Children must be present
              // for pending forms to scope to them right after a restart.
              const { active } = splitGlobalSessionsByArchived(
                await listGlobalSessionPages(listSessionPageOn(host), { directory: dir, pageSize: 500 }),
              )
              const allSessions = active
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const rootSessions = allSessions.filter((s) => !s.parentID)
              if (!isCurrent()) return

              // A cold OpenCode process can briefly return children before its
              // roots query catches up. Recover referenced parents from the
              // broader response or cache instead of publishing orphan rows.
              const current = store.getState()
              const { sessions, rootCount } = mergeBootstrapSessions(rootSessions, allSessions, current.session, {
                baselineRevision,
                eventRevision: current.sessionEventRevision,
                deletedRevision: current.sessionDeletedRevision,
              })
              store.setState({
                session: sessions,
                sessionTotal: rootCount,
                sessionListSource: "authoritative",
                limit: Math.max(sessions.length, 50),
              })
              ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
            },
          }))
          context.trackInitialization(bootstrap.environment.then((result) => {
            if (result === "failed") return failBootstrap()
          }))
          // A successful empty list is authoritative on every runtime: transient
          // failures throw and are retried per page inside loadSessions. VS Code
          // forwards a request only once its bundled OpenChamber server is
          // connected, and that server answers from its session store.
          const result = await bootstrap.sessions
          if (!isCurrent()) return "stale"
          return result
        }

        const result = await runBootstrap()
        if (result === "failed") await failBootstrap()

        // Selecting a session whose directory this client had not indexed yet
        // routes it through the active directory as a documented guess. This is
        // the moment that guess can be settled: the owning store now holds the
        // session, so the authoritative directory is finally readable. Without
        // this the guess survives, every fetch is addressed to a directory that
        // does not own the session, and the session never renders.
        if (result === "complete") {
          host.run(() => useSessionUIStore.getState().adoptAuthoritativeSessionDirectory())
        }
      },
      onDispose: (directory) => {
        messageLoader.invalidateDirectory(directory)
        lastStatusPollAtByDirectoryRef.current.delete(directory)
        lastFullResyncAtByDirectoryRef.current.delete(directory)
        lastChildDiscoveryAtByDirectoryRef.current.delete(directory)
      },
      isLoadingSessions: () => false,
    })
  }, [childStores, client, host, messageLoader, routingIndex, runtimeKey, sdk])

  // A space that left both lists, deleted here or from another window, takes its directories
  // with it: their stores and persisted caches go, so its chats show once, from the archive.
  useEffect(() => host.run(() => {
    let previous = knownSpaceIds(useSpacesStore.getState())
    let generation = spacesRuntimeGeneration()
    return useSpacesStore.subscribe((state) => host.run(() => {
      const next = knownSpaceIds(state)
      // A reset empties both lists without deleting anything: a runtime switch, whose stores go
      // their own way, or the switch turned off, whose spaces come back with it.
      const reset = spacesRuntimeGeneration() !== generation
      generation = spacesRuntimeGeneration()
      const gone = reset ? [] : spaceIdsGone(previous, next)
      previous = next
      if (gone.length === 0) return
      const goneIds = new Set(gone)
      for (const directory of Array.from(childStores.children.keys())) {
        const spaceId = spaceIdOfDirectory(directory)
        if (spaceId !== null && goneIds.has(spaceId)) childStores.forgetDirectory(directory)
      }
      // The open chat of a deleted space lives on under the archive's directory, which the
      // global list names: the selection follows it there, so the chat reads as the archive,
      // read-only, and not through the prefix the host answers with 404. The marks are applied
      // before the global snapshot that carries them, and the archive record may be on a later
      // page, so the move waits for the global store to name the directory.
      if (followCurrentChatToArchive(goneIds)) return
      const unsubscribe = useGlobalSessionsStore.subscribe(() => {
        if (host.run(() => followCurrentChatToArchive(goneIds))) unsubscribe()
      })
    }))
  }), [childStores, host])

  // Bootstrap global state — mark the host booting to suppress
  // redundant refresh events during startup
  useEffect(() => {
    const { boot } = syncHostStateOf(host)
    const generation = ++boot.generation
    boot.booting = true
    const globalActions = host.run(() => useGlobalSyncStore.getState().actions)
    host.run(() => bootstrapGlobal((patch) => {
      if (boot.generation === generation) {
        globalActions.set(patch)
      }
    }))
      .then(() => {
        if (boot.generation === generation) {
          boot.bootedAt = Date.now()
        }
      })
      .finally(() => {
        if (boot.generation === generation) {
          boot.booting = false
        }
      })
    return () => {
      if (boot.generation === generation) {
        boot.booting = false
      }
    }
  }, [host, sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const unsubscribeQueueEvents = subscribeMessageQueueSync(runtimeKey)
    const resyncAfterStreamGap = (reason: SessionMaterializationReason) => {
      // Cached transcripts may have missed events too; each revalidates its
      // tail the next time it is opened. Mark first so the active sessions'
      // tail refreshes below count as that revalidation.
      messageLoader.markHistoryStale()
      for (const dir of childStores.children.keys()) triggerDirectoryResync(dir, reason)
    }
    const pipeline = createEventPipeline({
      sdk,
      runtimeTransport: host.transport,
      apiBaseUrl: () => client.getBaseUrl(),
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => host.run(() => (
        resolveDirectoryFromRoutingIndex(host, routingIndex, directory, payload, childStores)
      )),
      // Track ALL stream activity (including heartbeats) as proof of
      // connection health. The watchdog stale check uses this to distinguish
      // a genuinely dead stream (no heartbeats for 20s) from a quiet-but-
      // connected session that is only receiving heartbeats. Excluding
      // heartbeats caused issue #1656: the stale timer fired for any quiet
      // session, triggering redundant full resyncs every ~15s. OpenCode 2
      // heartbeats never become events: OpenCode sends an SSE comment and the
      // WS bridge an `openchamber:heartbeat` frame, so delivered events miss them.
      onStreamActivity: () => {
        lastStreamActivityAtRef.current = Date.now()
      },
      onEvents: (directory, payloads) => host.run(() => {
        const batch = createDirectoryEventBatch()
        try {
          for (const payload of payloads) {
            dispatchVSCodeRuntimeNotificationEvent(directory, payload)
            if (payload.type === "installation.update-available") {
              const { version } = payload.properties
              if (version) dispatchOpenCodeUpdateAvailable({ version })
            }
            handleEvent(directory, payload, childStores, routingIndex, runtimeKey, false, currentDirectoryRef.current, batch)
          }
        } finally {
          publishDirectoryEventBatch(batch)
        }
      }),
      onSpaceStream: ({ spaceId, status }) => host.run(() => {
        // A space's stream went: its sessions may be old until it answers again. Back: re-read
        // that one space, the directories the global list knows for it, so a session made or
        // finished during the gap shows up without a full global reload.
        useSpacesStore.getState().noteStream(spaceId, status)
        // A stream that is back on a space this window lists as stopped means the space was started
        // elsewhere: the list is read again, so the group and the paused polls follow.
        if (status === "connected" && isSpaceStopped(spaceId)) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        if (status !== "connected") {
          // A space that stopped itself for the idle stop ends its stream on its way out. While the
          // host's list still says it runs, read the list again at each failed reconnect, which the
          // host paces, so the group says "stopped" rather than "not answering" once it is down.
          if (useSpacesStore.getState().journey?.get(spaceId)?.state === "running") {
            void refreshSpacesJourney().catch(() => undefined)
          }
          return
        }
        const directories = Array.from(useGlobalSessionsStore.getState().sessionsByDirectory.keys())
          .filter((directory) => spaceIdOfDirectory(directory) === spaceId)
        const spaceDirectory = useSpacesStore.getState().spaces.get(spaceId)?.directory
        if (spaceDirectory) directories.push(spaceDirectory)
        if (directories.length === 0) return
        void useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories).catch(() => undefined)
      }),
      onSpaceProgress: (progress) => host.run(() => {
        // A step of a creation moves the space's group on at once. A space this list has not seen,
        // made from another window among them, and the end of a creation, whose entry then comes
        // from the place, are read again from the journey route.
        const known = useSpacesStore.getState().noteProgress(progress)
        if (known && progress.step !== "ready" && progress.step !== "failed") return
        void refreshSpacesJourney().catch(() => undefined)
      }),
      onSpaceSetup: () => host.run(() => {
        // The setup commands of a space moved on; what they do now is in the list.
        void refreshSpacesJourney().catch(() => undefined)
      }),
      onReconnect: ({ replayReset }) => host.run(() => {
        // The first connection and every one after a gap: spaces being made or whose making failed
        // are known only to the journey list, and a step announced during the gap was missed.
        if (useUIStore.getState().isolatedSpacesEnabled && !isVSCodeRuntime()) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        // Queue recovery is independent of the directory-bootstrap debounce.
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        const isFirstConnect = !pipelineHasConnectedRef.current
        pipelineHasConnectedRef.current = true
        if (!replayReset && isFirstConnect && !pipelineDisconnectedBeforeFirstConnectRef.current) {
          return
        }
        if (!replayReset && isRecentBoot(host)) {
          return
        }
        resyncAfterStreamGap("stream-reconnect")
        if (!policyRef.current.focused) void useGlobalSessionsStore.getState().loadSessions().catch(() => undefined)
      }),
      onDisconnect: (reason) => host.run(() => {
        if (!pipelineHasConnectedRef.current) {
          pipelineDisconnectedBeforeFirstConnectRef.current = true
        }
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
          lastDisconnectReason: reason,
        })
      }),
      onTransportSwitch: () => host.run(() => {
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        // Transport changes are gap-prone in real networks. Treat them like a
        // reconnect and refresh active session snapshots from HTTP.
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        resyncAfterStreamGap("transport-switch")
      }),
    })
    pipelineReconnectRef.current = pipeline.reconnect
    return () => {
      if (pipelineReconnectRef.current === pipeline.reconnect) {
        pipelineReconnectRef.current = null
      }
      pipeline.cleanup()
      unsubscribeQueueEvents()
    }
  }, [sdk, childStores, client, currentDirectoryRef, host, messageLoader, routingIndex, messageStreamTransport, runtimeKey, triggerDirectoryResync])

  useEffect(() => {
    if (policy.focused) return
    void host.run(() => warmChatsRootDirectory())
      .then(() => host.run(() => ensureGlobalSessionsLoaded()))
      .then(() => host.run(() => seedGlobalSessionStatusFromHost()))
      .catch(() => undefined)
  }, [host, policy.focused])

  useEffect(() => {
    childStores.setEvictionLimits(policy.directoryStores)
    if (!policy.directoryStores) return
    const interval = setInterval(() => childStores.runEviction(), policy.evictionIntervalMs)
    return () => clearInterval(interval)
  }, [childStores, policy])

  useEffect(() => {
    if (!policy.watchdog) return
    let stopped = false
    let running = false
    const { childDiscoveryDirectories, statusPollingDirectories } = syncHostStateOf(host)

    const discoverChildSessions = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      parentSessionIds: string[],
    ) => {
      if (parentSessionIds.length === 0) return
      if (childDiscoveryDirectories.has(directory)) return
      childDiscoveryDirectories.add(directory)
      try {
        // Paginated so directories with > pageSize sessions are fully
        // discovered; a single 200-record page silently truncated the list and
        // left subagent children beyond it undiscovered.
        const { active: allSessions } = splitGlobalSessionsByArchived(
          await listGlobalSessionPages(listSessionPageOn(host), { directory, pageSize: 200 }),
        )
        const state = store.getState()
        const globalEntities = host.run(() => useGlobalSessionsStore.getState().entityById)
        const newChildSessions = selectNewChildSessions(
          allSessions,
          new Set(state.session.map((s) => s.id)),
          new Set(parentSessionIds),
          (sessionId) => Boolean(globalEntities.get(sessionId)?.time?.archived),
        )
        if (newChildSessions.length === 0) return
        // Collect unique parent IDs for materialization
        const parentIdsForMaterialization = new Set<string>()
        for (const session of newChildSessions) {
          if (session.parentID) parentIdsForMaterialization.add(session.parentID)
        }
        store.setState((state: DirectoryStore) => {
          const sessions = [...state.session, ...newChildSessions].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          )
          return { session: sessions, limit: Math.max(sessions.length, 50) }
        })
        // Trigger parent session materialization so the task tool part
        // state (metadata, sessionId, output) is refreshed.
        for (const pid of parentIdsForMaterialization) {
          enqueueSessionMaterialization(host, directory, pid, childStores, { reason: "child-session-discovered" })
        }
      } catch {
        // Best-effort — next tick will retry.
      } finally {
        childDiscoveryDirectories.delete(directory)
      }
    }

    const pollDirectoryStatuses = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      candidateSessionIds: string[],
    ) => {
      const polling = statusPollingDirectories
      if (polling.has(directory)) return
      polling.add(directory)
      try {
        const before = store.getState()
        const statuses = await runBackgroundNetworkTask(() => resyncDirectorySessionStatuses(host, directory, store, candidateSessionIds, "monotonic"), "active-session")
        if (!statuses) return
        const needsSnapshot = candidateSessionIds.some((sessionId) => (
          needsSnapshotAfterStatusPoll(before, sessionId, statuses[sessionId])
        ))
        if (needsSnapshot) {
          triggerDirectoryResync(directory, "stale-status-resync")
        }
      } finally {
        polling.delete(directory)
      }
    }

    const tick = () => {
      if (running || stopped) return
      running = true
      void Promise.resolve()
        .then(() => host.run(() => {
          if (stopped) return
          const now = Date.now()
          for (const [directory, store] of childStores.children.entries()) {
            // A stopped space answers nothing: the journey list is the authority, so its
            // directories wait, status as they last reported, until the list says it runs.
            if (isSpaceDirectoryStopped(directory)) continue
            const state = store.getState()
            const candidateSessionIds = getActiveSessionCandidateIds(host, directory, state)
            if (candidateSessionIds.length === 0) {
              lastStatusPollAtByDirectoryRef.current.delete(directory)
              lastFullResyncAtByDirectoryRef.current.delete(directory)
              continue
            }

            const lastStatusPollAt = lastStatusPollAtByDirectoryRef.current.get(directory) ?? 0
            if (now - lastStatusPollAt >= ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS) {
              lastStatusPollAtByDirectoryRef.current.set(directory, now)
              void pollDirectoryStatuses(directory, store, candidateSessionIds).catch(() => undefined)
            }

            const lastFullResyncAt = lastFullResyncAtByDirectoryRef.current.get(directory) ?? 0
            if (shouldTriggerStaleResync(lastStreamActivityAtRef.current, lastFullResyncAt, now)) {
              pipelineReconnectRef.current?.("active_stream_stale")
              triggerDirectoryResync(directory, "stale-status-resync")
            }

            // Discover child sessions created by other OpenCode instances
            // that didn't broadcast a session.created event on this stream.
            const lastChildDiscoveryAt = lastChildDiscoveryAtByDirectoryRef.current.get(directory) ?? 0
            if (now - lastChildDiscoveryAt >= CHILD_SESSION_DISCOVERY_INTERVAL_MS) {
              lastChildDiscoveryAtByDirectoryRef.current.set(directory, now)
              void discoverChildSessions(directory, store, candidateSessionIds)
            }
          }
        }))
        .finally(() => {
          running = false
          if (stopped) {
            statusPollingDirectories.clear()
          }
        })
    }

    const interval = setInterval(tick, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS)
    tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [childStores, host, policy.watchdog, sdk, triggerDirectoryResync])

  // Ensure current directory's child store exists
  useEffect(() => {
    let seedExpiryTimer: ReturnType<typeof setTimeout> | undefined
    if (directory) {
      const store = childStores.ensureChild(directory, {
        priority: "selected",
        reason: "current-directory",
      })
      const statusSeed = getRuntimeLiveStatusSeed(runtimeKey, directory)
      if (statusSeed) {
        store.setState((state: DirectoryStore) => ({
          session_status: {
            ...state.session_status,
            [statusSeed.sessionId]: state.session_status[statusSeed.sessionId] ?? statusSeed.status,
          },
        }))
        seedExpiryTimer = setTimeout(() => {
          store.setState((state: DirectoryStore) => {
            if (state.session_status[statusSeed.sessionId] !== statusSeed.status) {
              return state
            }
            return {
              session_status: {
                ...state.session_status,
                [statusSeed.sessionId]: { type: "idle" as const },
              },
            }
          })
        }, LIVE_STATUS_TTL_MS)
      }
      ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
    }
    return () => {
      if (seedExpiryTimer) clearTimeout(seedExpiryTimer)
    }
  }, [directory, childStores, routingIndex, runtimeKey])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => messageLoader.startCacheRetention({
    limit: policy.sessionCacheLimit ?? undefined,
    isCurrent: () => isHostRuntimeCurrent(host, runtimeKey),
    isViewed: ({ directory, sessionID }) => {
      const active = getActiveSession(host)
      return (directory === active?.directory && sessionID === active.sessionId)
        || (externallyViewedSessions.get(viewedSessionKey(host.id, directory, sessionID)) ?? 0) > Date.now()
    },
    isActive: ({ directory, sessionID }) => {
      const live = host.run(() => useGlobalSessionStatusStore.getState().statusById.get(sessionID))
      return live?.directory === directory && live.status.type !== "idle"
    },
    releaseDerivedCache: ({ directory, sessionID }) => {
      const store = childStores.getChild(directory)
      if (store) dropCachedSessionMessageRecordsSnapshots(store, [sessionID])
    },
  }), [childStores, host, messageLoader, policy, runtimeKey])

  useEffect(() => {
    host.run(() => {
      setImperativeSessionMessageLoader(messageLoader)
      setSyncRefs(sdk, childStores, directory, (sessionID, dir) => {
        setIndexedSessionDirectory(routingIndex, sessionID, dir)
      })
    })
    if (policy.focused) {
      setActionRefs(
        childStores,
        () => opencodeClient.getDirectory() || directory,
        (actionDirectory, sessionID, messageID) => {
          enqueueSessionMaterialization(host, actionDirectory, sessionID, childStores, {
            reason: "settled-running-tool",
            messageID,
          })
        },
      )
    }
    return () => host.run(() => {
      if (getImperativeSessionMessageLoader() === messageLoader) {
        setImperativeSessionMessageLoader(null)
      }
    })
  }, [sdk, directory, childStores, host, messageLoader, policy.focused, routingIndex])

  useEffect(() => {
    if (messageLoaderDisposalTimerRef.current) {
      clearTimeout(messageLoaderDisposalTimerRef.current)
      messageLoaderDisposalTimerRef.current = null
    }
    messageLoader.activate()
    return () => {
      // Strict Mode probes effects with setup → cleanup → setup in one task.
      // Deferring destruction lets child effects issue their second setup load
      // before this provider is installed again and cancels the cleanup.
      messageLoaderDisposalTimerRef.current = setTimeout(() => {
        messageLoaderDisposalTimerRef.current = null
        messageLoader.dispose()
        childStores.disposeAll()
      }, 0)
    }
  }, [childStores, messageLoader, messageLoaderDisposalTimerRef])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!directory) return
    const store = childStores.getChild(directory)
    if (!store) return
    host.run(() => updateStreamingState(store.getState()))
    const unsubscribe = store.subscribe((state, previous) => {
      host.run(() => updateChangedStreamingSessions(state, previous))
    })
    return unsubscribe
  }, [directory, childStores, host])
}

type SyncProviderProps = {
  sdk: OpenCodeClient
  directory: string
  hostsApi?: HostsAPI | null
  children: React.ReactNode
}

function SyncContexts(props: {
  parts: HostSyncParts
  runtimeKey: string
  sdk: OpenCodeClient
  directory: string
  children: React.ReactNode
}) {
  const { childStores, messageLoader, currentDirectory } = props.parts
  const runtime = useMemo<SyncRuntime>(
    () => ({ childStores, messageLoader, runtimeKey: props.runtimeKey, sdk: props.sdk, currentDirectory }),
    [childStores, currentDirectory, messageLoader, props.sdk, props.runtimeKey],
  )
  const system = useMemo<SyncSystem>(
    () => ({ ...runtime, directory: props.directory }),
    [props.directory, runtime],
  )

  // Directory navigation must not republish stable runtime dependencies.
  return (
    <SyncContext.Provider value={system}>
      <SyncRuntimeContext.Provider value={runtime}>
        {props.children}
      </SyncRuntimeContext.Provider>
    </SyncContext.Provider>
  )
}

function SingleHostSyncProvider(props: SyncProviderProps) {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey)
  const partsRef = useRef<{ runtimeKey: string; parts: HostSyncParts } | null>(null)
  // The cached list of an isolated space's directory seeds a store only while this window knows
  // the space: a deleted space's chats are on the Archive page, under the archive's own directory,
  // and the space's prefix answers 404. Given here so a store a consumer makes during the first
  // render, before `configure` runs, is gated too.
  if (partsRef.current?.runtimeKey !== runtimeKey) {
    partsRef.current = { runtimeKey, parts: createHostSyncParts(runtimeKey, opencodeClient, isDirectoryOfKnownSpace, props.directory) }
  }
  const { parts } = partsRef.current
  const hostRef = useRef<HostRuntime | null>(null)
  if (hostRef.current?.id !== runtimeKey) hostRef.current = resolveHost()
  const host = hostRef.current
  useHostSyncEngine({
    host,
    runtimeKey,
    sdk: props.sdk,
    client: opencodeClient,
    parts,
    directory: props.directory,
    policy: FOCUSED_HOST_SYNC_POLICY,
  })
  return (
    <SyncContexts parts={parts} runtimeKey={runtimeKey} sdk={props.sdk} directory={props.directory}>
      {props.children}
    </SyncContexts>
  )
}

const readHostSyncParts = defineHostValue((host) => createHostSyncParts(
  host.id,
  host.client,
  (directory) => host.run(() => isDirectoryOfKnownSpace(directory)),
  "",
))

const hostSyncPartsOf = (host: HostRuntime): HostSyncParts => host.run(readHostSyncParts)

const subscribeHosts = (notify: () => void) => hostRegistry.subscribe(notify)
const readHosts = () => hostRegistry.list()
const readFocusedHost = () => hostRegistry.focused()

function HostSyncEngine(props: { host: HostRuntime; focused: boolean; directory: string }) {
  const { host } = props
  useHostSyncEngine({
    host,
    runtimeKey: host.id,
    sdk: host.client.getSdkClient(),
    client: host.client,
    parts: hostSyncPartsOf(host),
    directory: props.directory,
    policy: hostSyncPolicy(props.focused, currentHostSyncSurface()),
  })
  return null
}

function HostRuntimesRoot(props: { directory: string }) {
  const hosts = React.useSyncExternalStore(subscribeHosts, readHosts, readHosts)
  const focused = React.useSyncExternalStore(subscribeHosts, readFocusedHost, readFocusedHost)
  return (
    <>
      {hosts.map((host) => (
        <HostScopeContext.Provider key={host.id} value={host.id}>
          <HostSyncEngine host={host} focused={host === focused} directory={host === focused ? props.directory : ""} />
        </HostScopeContext.Provider>
      ))}
    </>
  )
}

function HostSyncContexts(props: { host: HostRuntime; directory: string; children: React.ReactNode }) {
  const { host } = props
  return (
    <SyncContexts parts={hostSyncPartsOf(host)} runtimeKey={host.id} sdk={host.client.getSdkClient()} directory={props.directory}>
      {props.children}
    </SyncContexts>
  )
}

function FocusedSyncProvider(props: { directory: string; children: React.ReactNode }) {
  const host = React.useSyncExternalStore(subscribeHosts, readFocusedHost, readFocusedHost)
  return <HostSyncContexts host={host} directory={props.directory}>{props.children}</HostSyncContexts>
}

export function HostSyncScope(props: { hostId: HostId; children: React.ReactNode }) {
  const readHost = useCallback(() => hostRegistry.get(props.hostId) ?? null, [props.hostId])
  const host = React.useSyncExternalStore(subscribeHosts, readHost, readHost)
  if (!host) return null
  return (
    <HostScopeContext.Provider value={host.id}>
      <HostScopeSyncContexts host={host}>{props.children}</HostScopeSyncContexts>
    </HostScopeContext.Provider>
  )
}

function HostScopeSyncContexts(props: { host: HostRuntime; children: React.ReactNode }) {
  const { currentDirectory } = hostSyncPartsOf(props.host)
  const directory = React.useSyncExternalStore(currentDirectory.subscribe, currentDirectory.get, currentDirectory.get)
  return <HostSyncContexts host={props.host} directory={directory}>{props.children}</HostSyncContexts>
}

function MultiHostSyncProvider(props: SyncProviderProps) {
  const hostsApi = props.hostsApi ?? null
  useEffect(() => {
    void import("@/lib/hosts/runtime/saved-host-runtimes").then(({ savedHostRuntimes }) => savedHostRuntimes.ensure(hostsApi))
    void Promise.all([import("@/lib/hosts/runtime/runtime-hosts-monitoring"), import("@/lib/hosts/hosts-monitoring")]).then(([feed, hosts]) => {
      feed.installRuntimeHostsMonitoring()
      if (hostsApi) hosts.hostsMonitoring.ensure(hostsApi)
    })
  }, [hostsApi])
  return (
    <>
      <HostRuntimesRoot directory={props.directory} />
      <FocusedSyncProvider directory={props.directory}>{props.children}</FocusedSyncProvider>
    </>
  )
}

export function SyncProvider(props: SyncProviderProps) {
  const [multiHost] = React.useState(isMultiHostRuntimeEnabled)
  if (!multiHost) return <SingleHostSyncProvider {...props} />
  return <MultiHostSyncProvider {...props} />
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Get the child store for a directory (defaults to current).
 *
 * Pass `{ bootstrap: false }` when you only need the store reference for an
 * on-demand `getState()` (not live subscription) and must NOT trigger a full
 * directory bootstrap. This avoids storms of pointless session-list fetches +
 * empty-retry loops for directories that are merely referenced by sidebar rows
 * (e.g. archived sessions on deleted worktrees).
 */
export function useDirectoryStore(
  directory?: string,
  options?: {
    bootstrap?: boolean
    priority?: DirectoryBootstrapPriority
    reason?: DirectoryBootstrapReason
  },
): StoreApi<DirectoryStore> {
  const runtime = useSyncRuntime()
  // With an explicit directory the snapshot is a constant, so a current-
  // directory change does not re-render this consumer.
  const dir = React.useSyncExternalStore(
    runtime.currentDirectory.subscribe,
    () => directory ?? runtime.currentDirectory.get(),
  )
  const store = runtime.childStores.ensureChild(dir, options)

  useEffect(() => {
    runtime.childStores.pin(dir)
    return () => runtime.childStores.unpin(dir)
  }, [dir, runtime.childStores])

  return store
}

export function useSessionMessageLoader(): SessionMessageLoader {
  return useSyncRuntime().messageLoader
}

export function useSessionMessageLoadState(sessionID: string, directory?: string): SessionMessageLoadState {
  const system = useSyncSystem()
  const runtimeKey = system.runtimeKey
  const target = useMemo(() => ({ directory: directory ?? system.directory, sessionID }), [directory, sessionID, system.directory])
  return React.useSyncExternalStore(
    useCallback((notify) => {
      void runtimeKey
      return sessionID && target.directory ? system.messageLoader.subscribe(target, notify) : () => undefined
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => {
      void runtimeKey
      return sessionID && target.directory
        ? system.messageLoader.getSnapshot(target)
        : EMPTY_SESSION_MESSAGE_LOAD_STATE
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => EMPTY_SESSION_MESSAGE_LOAD_STATE, []),
  )
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_MESSAGES
    return store.getState().message[sessionID] ?? EMPTY_MESSAGES
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.message[sessionID] !== previous.message[sessionID]) notify()
    })
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Derive one value from a session's message list. The caller re-renders only
 * when the derived value changes under `isEqual`, not on every message update:
 * a streamed step replaces the list many times while a derived flag or reading
 * stays the same. `select` runs when the session's list changes, and again on
 * the caller's own renders, so it reads current state either way. A selector
 * that also reads message parts passes `watchParts`, so parts that load after
 * their message re-run it too.
 */
export function useSessionMessagesSelector<T>(
  sessionID: string,
  directory: string | undefined,
  select: (messages: Message[], state: State) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  watchParts = false,
): T {
  const store = useDirectoryStore(directory)
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const next = select(sessionID ? state.message[sessionID] ?? EMPTY_MESSAGES : EMPTY_MESSAGES, state)
    const cached = cacheRef.current
    if (cached && isEqual(cached.value, next)) return cached.value
    cacheRef.current = { value: next }
    return next
  }, [isEqual, select, sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.message[sessionID] !== previous.message[sessionID] || (watchParts && state.part !== previous.part)) notify()
    })
  }, [sessionID, store, watchParts])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Check whether the message list for a session has been loaded into sync state. */
export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

const EMPTY_PARTS_BY_MESSAGE: Record<string, Part[]> = {}

/**
 * Get parts for several messages at once, keyed by message id. The snapshot
 * keeps its identity until one of the requested part arrays changes, so a
 * streaming turn can overlay every one of its step messages — not only the
 * currently streaming one — without tearing between them when the stream
 * moves to the next message.
 */
export function useSessionPartsForMessages(messageIDs: readonly string[], directory?: string): Record<string, Part[]> {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{ ids: readonly string[]; parts: Record<string, Part[]> } | null>(null)
  const getSnapshot = useCallback(() => {
    if (messageIDs.length === 0) return EMPTY_PARTS_BY_MESSAGE
    const state = store.getState()
    const cached = cacheRef.current
    if (
      cached
      && cached.ids === messageIDs
      && messageIDs.every((id) => (state.part[id] ?? EMPTY_PARTS) === (cached.parts[id] ?? EMPTY_PARTS))
    ) {
      return cached.parts
    }
    const parts: Record<string, Part[]> = {}
    for (const id of messageIDs) parts[id] = state.part[id] ?? EMPTY_PARTS
    cacheRef.current = { ids: messageIDs, parts }
    return parts
  }, [messageIDs, store])
  const subscribe = useCallback((notify: () => void) => {
    if (messageIDs.length === 0) return () => undefined
    return store.subscribe((state, previous) => {
      for (const id of messageIDs) {
        if (state.part[id] !== previous.part[id]) {
          notify()
          return
        }
      }
    })
  }, [messageIDs, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return undefined
    return store.getState().session_status?.[sessionID]
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.session_status?.[sessionID] !== previous.session_status?.[sessionID]) notify()
    })
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Whether this directory has received a successful authoritative status snapshot. */
export function useSessionStatusSnapshotReady(directory?: string, sessionID?: string): boolean {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    return state.sessionStatusReady === true && (!sessionID || !state.sessionStatusInvalidated?.[sessionID])
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.sessionStatusReady !== previous.sessionStatusReady
      || (sessionID && state.sessionStatusInvalidated?.[sessionID] !== previous.sessionStatusInvalidated?.[sessionID])) notify()
  }), [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string, options?: { bootstrap?: boolean }) {
  const store = useDirectoryStore(directory, options)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_PERMISSION_REQUESTS
    return store.getState().permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return subscribeDirectoryPermission(store, sessionID, notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get pending forms for a specific session */
export function useSessionForms(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.form[sessionID] ?? EMPTY_FORM_REQUESTS, [sessionID]),
    directory,
  )
}

type SessionBlockingRequests = {
  hasPermission: boolean
  hasForm: boolean
}

const NO_SESSION_BLOCKING_REQUESTS: SessionBlockingRequests = {
  hasPermission: false,
  hasForm: false,
}

/**
 * Whether any pending permission or form waits in exact session buckets
 * grouped by owning directory. This lets collapsed rows cover hidden
 * descendants without bootstrapping their stores or subscribing to unrelated
 * updates.
 */
export function useSessionBlockingRequests(
  scopes: readonly { directory: string; sessionIDs: readonly string[] }[],
): SessionBlockingRequests {
  // Runtime only: the current directory is not an input here, and reading the
  // directory-bearing context would re-render every sidebar row that shows
  // blocking requests whenever the user switches projects.
  const { childStores } = useSyncRuntime()
  const scopedStores = React.useMemo(() => scopes.map((scope) => ({
    sessionIDs: scope.sessionIDs,
    store: childStores.ensureChild(scope.directory, { bootstrap: false }),
  })), [childStores, scopes])
  React.useEffect(() => {
    for (const scope of scopes) childStores.pin(scope.directory)
    return () => {
      for (const scope of scopes) childStores.unpin(scope.directory)
    }
  }, [childStores, scopes])
  const snapshotRef = useRef(NO_SESSION_BLOCKING_REQUESTS)
  const getSnapshot = React.useCallback(() => {
    let hasPermission = false
    let hasForm = false
    // The cross-directory index covers directories whose store never loaded
    // (the host seed fills it), and it is what the "Needs you" zone lists
    // from, so a row there always shows why. Pages that wait for the user's
    // answer are only in the index; they count as a form.
    const indexed = useGlobalBlockingRequestsStore.getState().bySession
    for (const { sessionIDs, store } of scopedStores) {
      const { permission: permissions, form: forms } = store.getState()
      for (const sessionID of sessionIDs) {
        const pending = indexed.get(sessionID)
        hasPermission ||= Boolean(permissions[sessionID]?.length) || Boolean(pending?.permissions.length)
        hasForm ||= Boolean(forms[sessionID]?.length) || Boolean(pending?.forms.length) || Boolean(pending?.pages.length)
      }
    }
    const previous = snapshotRef.current
    if (previous.hasPermission === hasPermission && previous.hasForm === hasForm) {
      return previous
    }
    const next = { hasPermission, hasForm }
    snapshotRef.current = next
    return next
  }, [scopedStores])
  const subscribe = React.useCallback((notify: () => void) => {
    const unsubscribers = [
      ...scopedStores.flatMap(({ sessionIDs, store }) => [
        subscribeDirectoryPermissions(store, sessionIDs, notify),
        subscribeDirectoryForms(store, sessionIDs, notify),
      ]),
      // Rare writes; getSnapshot keeps the same object when nothing changed.
      useGlobalBlockingRequestsStore.subscribe(notify),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [scopedStores])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const selectPermissionRequestsBySession = (state: State) => state.permission
const selectFormRequestsBySession = (state: State) => state.form

/**
 * Forms for the composer of `sessionID`: the session subtree's own, then the
 * directory's location-scoped ones. A location-scoped form has no session to
 * be viewed from, so every session of its directory offers it; the answer is
 * still sent to that directory's OpenCode instance because the reply
 * resolves its directory from the store that holds the form.
 */
export const collectComposerForms = (
  sessions: Session[],
  formsBySession: Record<string, FormRequest[] | undefined>,
  sessionID: string | null,
  empty: FormRequest[],
): FormRequest[] => {
  const own = collectScopedBlockingRequests(sessions, formsBySession, sessionID, empty)
  const locationScoped = sessionID ? formsBySession[LOCATION_SCOPED_FORM_SESSION_ID] : undefined
  if (!locationScoped || locationScoped.length === 0) return own
  return own === empty ? locationScoped : [...own, ...locationScoped]
}

type ScopedBlockingRequestCache<T extends { id: string }> = {
  sessionID: string | null
  sessions: Session[] | null
  requestsBySession: Record<string, T[] | undefined> | null
  result: T[]
}

function useScopedBlockingRequests<T extends { id: string }>(
  sessionID: string | null,
  directory: string | undefined,
  selectRequestsBySession: (state: State) => Record<string, T[] | undefined>,
  empty: T[],
  collect: (
    sessions: Session[],
    requestsBySession: Record<string, T[] | undefined>,
    sessionID: string | null,
    empty: T[],
  ) => T[] = collectScopedBlockingRequests,
): T[] {
  const cacheRef = useRef<ScopedBlockingRequestCache<T>>({
    sessionID: null,
    sessions: null,
    requestsBySession: null,
    result: empty,
  })

  return useDirectorySync(
    useCallback((state: State) => {
      const requestsBySession = selectRequestsBySession(state)
      const cache = cacheRef.current
      if (
        cache.sessionID === sessionID
        && cache.sessions === state.session
        && cache.requestsBySession === requestsBySession
      ) {
        return cache.result
      }

      const next = collect(state.session, requestsBySession, sessionID, empty)
      const result = areRequestArraysReferentiallyEqual(cache.result, next) ? cache.result : next
      cacheRef.current = {
        sessionID,
        sessions: state.session,
        requestsBySession,
        result,
      }
      return result
    }, [collect, empty, selectRequestsBySession, sessionID]),
    directory,
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingForms(sessionID: string | null, directory?: string): FormRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectFormRequestsBySession, EMPTY_FORM_REQUESTS, collectComposerForms)
}

const sessionsByIdCache = new WeakMap<State["session"], Map<string, Session>>()

const getSessionById = (sessions: State["session"], sessionID?: string | null): Session | undefined => {
  if (!sessionID) return undefined
  let sessionsById = sessionsByIdCache.get(sessions)
  if (!sessionsById) {
    sessionsById = new Map(sessions.map((session) => [session.id, session]))
    sessionsByIdCache.set(sessions, sessionsById)
  }
  return sessionsById.get(sessionID)
}

export function useParentSession(sessionID: string | null, directory?: string): Session | null {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return null
      const current = getSessionById(state.session, sessionID)
      if (!current?.parentID) return null
      return getSessionById(state.session, current.parentID)
        ?? getAllSyncSessions().find((s) => s.id === current.parentID)
        ?? null
    }, [sessionID]),
    directory,
  )
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncRuntime()
  const getSnapshot = useCallback(() => {
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      return sessions ? getSessionById(sessions, sessionID) : undefined
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify()
      })
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Derive one value from a session record. `session.updated` replaces the
 * record on every streamed step (its `time.updated` moves), so a caller that
 * reads only a few fields re-renders only when the derived value changes
 * under `isEqual`. Same lookup and subscription as `useSession`.
 */
export function useSessionSelector<T>(
  sessionID: string | null | undefined,
  directory: string | undefined,
  select: (session: Session | undefined) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const { childStores } = useSyncRuntime()
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    let session: Session | undefined
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      session = sessions ? getSessionById(sessions, sessionID) : undefined
    } else {
      session = findLiveSession(getLiveStates(childStores), sessionID)
    }
    const next = select(session)
    const cached = cacheRef.current
    if (cached && isEqual(cached.value, next)) return cached.value
    cacheRef.current = { value: next }
    return next
  }, [childStores, directory, isEqual, select, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify()
      })
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectSessionDirectory = (session: Session | undefined): string | undefined => session?.directory ?? undefined

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  return useSessionSelector(sessionID, directory, selectSessionDirectory)
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncRuntime().childStores
}

type SessionMessageRecord = { info: Message; parts: Part[] }
const EMPTY_SESSION_MESSAGE_RECORDS: SessionMessageRecord[] = []

type SessionMessageRecordsSnapshot = {
  sessionID: string
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
  suspendPartUpdates: boolean
  suspendedPartUpdatesMessageID?: string
  list: SessionMessageRecord[]
  byId: Map<string, SessionMessageRecord>
}

const SESSION_MESSAGE_RECORDS_CACHE_MAX = 40
const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4
const VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30
const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX = 4
const MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES = 30
const sessionMessageRecordsCache = new WeakMap<StoreApi<DirectoryStore>, Map<string, SessionMessageRecordsSnapshot>>()

const getSessionMessageRecordsCacheKey = (
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): string => (
  `${sessionID}\u0000${suspendPartUpdates ? 1 : 0}\u0000${suspendedPartUpdatesMessageID ?? ""}`
)

const getSessionMessageRecordsCache = (store: StoreApi<DirectoryStore>): Map<string, SessionMessageRecordsSnapshot> => {
  let cache = sessionMessageRecordsCache.get(store)
  if (!cache) {
    cache = new Map()
    sessionMessageRecordsCache.set(store, cache)
  }
  return cache
}

const readCachedSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return undefined
  const key = getSessionMessageRecordsCacheKey(sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  const cached = cache.get(key)
  if (!cached) return undefined
  cache.delete(key)
  cache.set(key, cached)
  return cached
}

const rememberSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  snapshot: SessionMessageRecordsSnapshot,
): void => {
  if (!snapshot.sessionID) return
  const cache = getSessionMessageRecordsCache(store)
  const key = getSessionMessageRecordsCacheKey(
    snapshot.sessionID,
    snapshot.suspendPartUpdates,
    snapshot.suspendedPartUpdatesMessageID,
  )
  const constrainedMaxMessages = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX_MESSAGES
      : null
  if (constrainedMaxMessages !== null && snapshot.list.length > constrainedMaxMessages) {
    cache.delete(key)
    return
  }
  cache.delete(key)
  cache.set(key, snapshot)
  const max = isVSCodeRuntime()
    ? VSCODE_SESSION_MESSAGE_RECORDS_CACHE_MAX
    : isMobileSurfaceRuntime()
      ? MOBILE_SESSION_MESSAGE_RECORDS_CACHE_MAX
      : SESSION_MESSAGE_RECORDS_CACHE_MAX
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

function dropCachedSessionMessageRecordsSnapshots(
  store: StoreApi<DirectoryStore>,
  sessionIDs: Iterable<string>,
): void {
  const cache = sessionMessageRecordsCache.get(store)
  if (!cache) return
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const prefix = `${sessionID}\u0000`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key)
      }
    }
  }
}

type TaskToolPart = Extract<Part, { type: "tool" }>

const isTaskToolPart = (part: Part | undefined): part is TaskToolPart => (
  part?.type === "tool" && part.tool?.trim().toLowerCase() === "task"
)

const readTaskSessionId = (part: Part | undefined): string | undefined => {
  if (!isTaskToolPart(part)) return undefined
  const metadata = (part.state as { metadata?: unknown } | undefined)?.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const record = metadata as { sessionId?: unknown; sessionID?: unknown }
  const value = typeof record.sessionId === "string" ? record.sessionId : record.sessionID
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const hasTaskSessionIdentityChange = (previous: Part[], current: Part[] | undefined): boolean => {
  let previousTaskCount = 0
  for (const part of previous) {
    if (!isTaskToolPart(part)) continue
    previousTaskCount += 1
    const currentPart = current?.find((candidate) => candidate.id === part.id && isTaskToolPart(candidate))
    if (!currentPart || readTaskSessionId(part) !== readTaskSessionId(currentPart)) return true
  }

  let currentTaskCount = 0
  for (const part of current ?? EMPTY_PARTS) {
    if (isTaskToolPart(part)) currentTaskCount += 1
  }
  return previousTaskCount !== currentTaskCount
}

const snapshotPartsMatchState = (snapshot: SessionMessageRecordsSnapshot, state: State): boolean => {
  for (const record of snapshot.list) {
    if (snapshot.suspendPartUpdates) {
      const suspendedID = snapshot.suspendedPartUpdatesMessageID
      if (
        (!suspendedID || record.info.id === suspendedID)
        && !hasTaskSessionIdentityChange(record.parts, state.part[record.info.id])
      ) {
        continue
      }
    }
    if ((state.part[record.info.id] ?? EMPTY_PARTS) !== record.parts) {
      return false
    }
  }

  return true
}

// Session lists are ID-sorted; snapshot reads run on every store notification,
// so the revert lookup must not scan the directory's whole session list.
const getSessionRevertMessageID = (sessions: State["session"], sessionID: string): string | undefined => {
  const result = Binary.search(sessions, sessionID, (session) => session.id)
  return result.found ? sessions[result.index]?.revert?.messageID : undefined
}

const getReusableSessionMessageRecordsSnapshot = (
  store: StoreApi<DirectoryStore>,
  state: State,
  sessionID: string,
  suspendPartUpdates: boolean,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot | undefined => {
  const cached = readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)
  if (!cached) return undefined
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const revertMessageID = getSessionRevertMessageID(state.session, sessionID)
  if (
    cached.sourceMessages === sourceMessages
    && cached.revertMessageID === revertMessageID
    && cached.suspendPartUpdates === suspendPartUpdates
    && cached.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && snapshotPartsMatchState(cached, state)
  ) {
    return cached
  }
  return undefined
}

function getVisibleMessagesForSession(state: State, sessionID: string, previous?: SessionMessageRecordsSnapshot): {
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
} {
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const revertMessageID = getSessionRevertMessageID(state.session, sessionID)

  if (
    previous
    && previous.sourceMessages === sourceMessages
    && previous.revertMessageID === revertMessageID
  ) {
    return {
      sourceMessages,
      visibleMessages: previous.visibleMessages,
      revertMessageID,
    }
  }

  return {
    sourceMessages,
    visibleMessages: messagesBefore(sourceMessages, revertMessageID),
    revertMessageID,
  }
}

export function buildSessionMessageRecordsSnapshot(
  state: State,
  sessionID: string,
  previous?: SessionMessageRecordsSnapshot,
  suspendPartUpdates = false,
  suspendedPartUpdatesMessageID?: string,
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const shouldSuspendParts = suspendPartUpdates
      && previousRecord
      && (!suspendedPartUpdatesMessageID || message.id === suspendedPartUpdatesMessageID)
      && !hasTaskSessionIdentityChange(previousRecord.parts, state.part[message.id])
    const parts = shouldSuspendParts
      ? previousRecord.parts
      : (state.part[message.id] ?? EMPTY_PARTS)

    const nextRecord = previousRecord && previousRecord.info === message && previousRecord.parts === parts
      ? previousRecord
      : { info: message, parts }

    nextById.set(message.id, nextRecord)
    return nextRecord
  })

  const unchanged = Boolean(previous)
    && previous?.visibleMessages === visibleMessages
    && previous.suspendPartUpdates === suspendPartUpdates
    && previous.suspendedPartUpdatesMessageID === suspendedPartUpdatesMessageID
    && previous.list.length === nextList.length
    && previous.list.every((record, index) => record === nextList[index])

  if (unchanged && previous) {
    return previous
  }

  return {
    sessionID,
    sourceMessages,
    visibleMessages,
    revertMessageID,
    suspendPartUpdates,
    suspendedPartUpdatesMessageID,
    list: nextList,
    byId: nextById,
  }
}

export function useSessionRenderable(sessionID: string, directory?: string): boolean {
  const store = useDirectoryStore(directory)
  const renderableRef = useRef(false)
  const getSnapshot = useCallback(() => {
    const renderable = Boolean(sessionID && getSessionMaterializationStatus(store.getState(), sessionID).renderable)
    renderableRef.current = renderable
    return renderable
  }, [sessionID, store])
  const subscribe = useCallback(
    (notify: () => void) => sessionID
      ? subscribeDirectorySessionMessages(store, sessionID, (change) => {
          const state = store.getState()
          const remainsRenderable = change.partMessageIDs.every((messageID) => (
            Object.prototype.hasOwnProperty.call(state.part, messageID)
          ))
          if (
            !change.messagesChanged
            && !change.reset
            && change.partMessageIDs.length > 0
            && renderableRef.current
            && remainsRenderable
          ) {
            countSyncPerformance("sessionRenderableNotificationSkips")
            return
          }
          notify()
        })
      : () => undefined,
    [sessionID, store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const EMPTY_RECORD_IDS: ReadonlySet<string> = new Set()
const userHistoryRecordIDs = new WeakMap<UserMessageHistorySnapshot["records"], ReadonlySet<string>>()

// Part notifications during streaming carry many message IDs; one ID set per
// records array keeps the relevance check linear instead of parts × prompts.
const getUserHistoryRecordIDs = (snapshot: UserMessageHistorySnapshot): ReadonlySet<string> => {
  let ids = userHistoryRecordIDs.get(snapshot.records)
  if (!ids) {
    ids = new Set(snapshot.records.map((record) => record.message.id))
    userHistoryRecordIDs.set(snapshot.records, ids)
  }
  return ids
}

/**
 * The user's prompts in the visible transcript of a session, oldest first.
 * Session-scoped ArrowUp recall merges this with the persisted input history,
 * so sessions that predate the persisted store still recall their prompts.
 */
export function useUserMessageHistory(sessionID: string, directory?: string): TranscriptPrompt[] {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<UserMessageHistorySnapshot>(EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT)

  const getSnapshot = useCallback(() => {
    const next = buildUserMessageHistorySnapshot(store.getState(), sessionID, snapshotRef.current)
    snapshotRef.current = next
    return next.history
  }, [sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    const unsubscribeMessages = subscribeDirectorySessionMessages(store, sessionID, (change) => {
      if (!change.messagesChanged && !change.reset && change.partMessageIDs.length > 0) {
        const snapshot = snapshotRef.current
        const recordIDs = snapshot.sessionID === sessionID ? getUserHistoryRecordIDs(snapshot) : EMPTY_RECORD_IDS
        const affectsUserHistory = change.partMessageIDs.some((messageID) => recordIDs.has(messageID))
        if (!affectsUserHistory) {
          countSyncPerformance("userMessageHistoryNotificationSkips")
          return
        }
      }
      notify()
    })
    const unsubscribeSession = store.subscribe((state, previous) => {
      if (state.session === previous.session) return
      if (getSessionRevertMessageID(state.session, sessionID) !== getSessionRevertMessageID(previous.session, sessionID)) notify()
    })
    return () => {
      unsubscribeMessages()
      unsubscribeSession()
    }
  }, [sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { enabled?: boolean; suspendPartUpdates?: boolean; suspendPartUpdatesForMessageId?: string | null },
) {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<SessionMessageRecordsSnapshot>({
    sessionID,
    sourceMessages: EMPTY_MESSAGES,
    visibleMessages: EMPTY_MESSAGES,
    revertMessageID: undefined,
    suspendPartUpdates: Boolean(options?.suspendPartUpdates),
    suspendedPartUpdatesMessageID: options?.suspendPartUpdatesForMessageId ?? undefined,
    list: [],
    byId: new Map(),
  })

  const getSnapshot = useCallback(() => {
    if (!sessionID) {
      return EMPTY_SESSION_MESSAGE_RECORDS
    }
    if (options?.enabled === false) {
      return snapshotRef.current.sessionID === sessionID ? snapshotRef.current.list : EMPTY_SESSION_MESSAGE_RECORDS
    }

    const state = store.getState()
    const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
    const suspendedPartUpdatesMessageID = options?.suspendPartUpdatesForMessageId ?? undefined
    const reusableSnapshot = getReusableSessionMessageRecordsSnapshot(
      store,
      state,
      sessionID,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    if (reusableSnapshot) {
      snapshotRef.current = reusableSnapshot
      return reusableSnapshot.list
    }

    const previousSnapshot = snapshotRef.current.sessionID === sessionID
      ? snapshotRef.current
      : readCachedSessionMessageRecordsSnapshot(store, sessionID, suspendPartUpdates, suspendedPartUpdatesMessageID)

    const nextSnapshot = buildSessionMessageRecordsSnapshot(
      state,
      sessionID,
      previousSnapshot,
      suspendPartUpdates,
      suspendedPartUpdatesMessageID,
    )
    snapshotRef.current = nextSnapshot
    rememberSessionMessageRecordsSnapshot(store, nextSnapshot)
    return nextSnapshot.list
  }, [options?.enabled, options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID || options?.enabled === false) return () => undefined
    const unsubscribeMessages = subscribeDirectorySessionMessages(store, sessionID, (change) => {
      const suspendPartUpdates = Boolean(options?.suspendPartUpdates)
      const suspendedPartUpdatesMessageID = options?.suspendPartUpdatesForMessageId ?? undefined
      if (!change.messagesChanged && !change.reset && suspendPartUpdates && change.partMessageIDs.length > 0) {
        const state = store.getState()
        const snapshot = snapshotRef.current.sessionID === sessionID ? snapshotRef.current : undefined
        const allChangesSuspended = change.partMessageIDs.every((messageID) => {
          if (suspendedPartUpdatesMessageID && messageID !== suspendedPartUpdatesMessageID) return false
          const previousParts = snapshot?.byId.get(messageID)?.parts
          return Boolean(
            previousParts
            && !hasTaskSessionIdentityChange(previousParts, state.part[messageID]),
          )
        })
        if (allChangesSuspended) {
          countSyncPerformance("sessionMessageRecordNotificationSkips")
          return
        }
      }
      notify()
    })
    const unsubscribeSession = store.subscribe((state, previous) => {
      if (state.session === previous.session) return
      if (getSessionRevertMessageID(state.session, sessionID) !== getSessionRevertMessageID(previous.session, sessionID)) notify()
    })
    return () => {
      unsubscribeMessages()
      unsubscribeSession()
    }
  }, [options?.enabled, options?.suspendPartUpdates, options?.suspendPartUpdatesForMessageId, sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_FORM_REQUESTS: FormRequest[] = []

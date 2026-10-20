import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useSpaceArchivesStore } from '@/lib/spaces/space-archives';
import { resetSpaceModelAccess } from '@/lib/spaces/space-model-access';
import { resetSpaceCreationRequests } from '@/lib/spaces/space-creation';
import { useGuestsStore } from '@/lib/guests/store';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { opencodeClient } from '@/lib/opencode/client';
import { hostRegistry } from '@/lib/hosts/runtime/app-host';
import { isHostFocusMove } from '@/lib/hosts/runtime/multi-host-flag';
import { isTransientRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange, type RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useChangeRequestContextStore } from '@/stores/useChangeRequestContextStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useEngineReadinessStore } from '@/stores/useEngineReadinessStore';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { resetBackgroundShells } from '@/sync/background-shells';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { syncDesktopSettings } from '@/lib/persistence';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';

// Same-device transport switch (LAN⇄relay for one paired device): rebind the SDK
// to the new transport WITHOUT tearing down connection/session state or remounting
// the sync layer. `reconnectToRuntimeBaseUrl` swaps in a fresh SDK client; the
// caller then forces a re-render so SyncProvider receives it as a new `sdk` prop,
// which re-runs its event-pipeline + bootstrap effects (keyed on `sdk`) to
// reconnect over the new transport IN PLACE. Message-pagination refs, the open
// session, and the whole view are preserved — no reconnecting screen, no flash,
// no bounce back to the draft.
export const reconnectAppForTransportSwitch = (): void => {
  disposeTerminalInputTransport();
  hostRegistry.focused().client.reconnectToRuntimeBaseUrl();
  resetStreamingState();
};

const resetSameHostEventStores = (): void => {
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  replaceGlobalSessionStatusById(new Map());
  resetGlobalBlockingRequests();
  resetBackgroundShells();
  resetSessionOrdering();
  resetSessionActivityTiming();
  usePermissionStore.getState().reset();
};

const resetSameHostUiStores = (): void => {
  useConfigStore.setState({
    providers: [],
    agents: [],
    isConnected: false,
    isInitialized: false,
    connectionPhase: 'connecting',
    lastDisconnectReason: null,
  });
  useProjectsStore.getState().resetForRuntimeSwitch();
  useProjectContextStore.getState().reset();
  useSpacesStore.getState().resetForRuntimeSwitch();
  useSpaceArchivesStore.getState().resetForRuntimeSwitch();
  resetSpaceModelAccess();
  resetSpaceCreationRequests();
  useSessionUIStore.setState({ worktreeDiscoveryByProject: new Map() });
};

const resetSameHostFocusedStores = (runtimeKey: string): void => {
  disposeTerminalInputTransport();
  useTerminalStore.getState().clearAll();
  useCommandsStore.getState().resetForRuntimeSwitch();
  useAgentsStore.getState().resetForRuntimeSwitch();
  useFileSearchStore.getState().resetForRuntimeSwitch();
  useGitStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGitIdentitiesStore.getState().resetForRuntimeSwitch(runtimeKey);
  useSourceControlAuthStore.getState().resetForRuntimeSwitch();
  repositoryBindingOwner.reset();
  useChangeRequestContextStore.getState().resetForRuntimeSwitch();
  useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  useFilesViewTabsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestOauthStore.getState().resetForRuntimeSwitch();
  useLinearAuthStore.getState().resetForRuntimeSwitch();
  useQuotaStore.getState().resetForRuntimeSwitch();
  useMcpStore.getState().resetForRuntimeSwitch();
  useSkillsStore.getState().resetForRuntimeSwitch();
  useEngineReadinessStore.getState().resetForRuntimeSwitch();
  useEngineControlsStore.getState().resetForRuntimeSwitch();
  useAgentMemoryStore.getState().reset();
};

export const isFocusSwitch = isHostFocusMove;

export const prepareAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  if (detail.runtimeKey === detail.previousRuntimeKey || isFocusSwitch(detail)) return;
  useSessionUIStore.getState().rememberForRuntimeSwitch();
};

const focusAppOnHost = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionMultiSelectStore.getState().disable();
  sessionEvents.cancelPendingGitRefreshes();
  useWalkthroughStore.getState().reset();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useUIStore.getState().setOpenGuestPage(null);
  queueMicrotask(() => void syncDesktopSettings());
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  if (isFocusSwitch(detail)) {
    focusAppOnHost(detail);
    return;
  }
  const sameHost = detail.runtimeKey === detail.previousRuntimeKey;
  if (sameHost) resetSameHostFocusedStores(detail.runtimeKey);
  opencodeClient.reconnectToRuntimeBaseUrl();
  if (sameHost) {
    resetSameHostEventStores();
    resetSameHostUiStores();
  }
  useSessionMultiSelectStore.getState().disable();
  sessionEvents.cancelPendingGitRefreshes();
  useWalkthroughStore.getState().reset();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  if (!sameHost) useSessionUIStore.getState().resumeAfterRuntimeSwitch(detail.previousRuntimeKey);
  useUIStore.getState().setOpenGuestPage(null);
  resetStreamingState();
  queueMicrotask(() => void syncDesktopSettings());
};

export const isHostToHostSwitch = (detail: RuntimeEndpointChangedDetail): boolean => (
  Boolean(detail.apiBaseUrl)
  && detail.runtimeKey !== detail.previousRuntimeKey
  && !isTransientRuntimeKey(detail.runtimeKey)
  && !isTransientRuntimeKey(detail.previousRuntimeKey)
);

/**
 * True when the endpoint event only replaced credentials for the runtime that
 * was already active, as the login gate does after a successful sign-in.
 */
export const isSameRuntimeEndpoint = (detail: RuntimeEndpointChangedDetail): boolean => (
  detail.runtimeKey === detail.previousRuntimeKey && detail.apiBaseUrl === detail.previousApiBaseUrl
);

// Web and desktop reset for a change of runtime from the entry point, not from
// App: the auth and compatibility gates unmount App while they show the login,
// error, or version screen, and a host switch made from their switcher would
// otherwise leave the SDK client and stores on the previous runtime. App then
// mounts against the new runtime with an SDK that still calls the old one, so
// initialization never completes and the startup overlay never lifts.
// A same-runtime credential change stays with App, which resets only while
// mounted: a sign-in on the login screen must keep the terminal tabs and
// auto-review runs of the host being unlocked. Mobile keeps its own subscriber
// because it tells transport switches apart from runtime switches.
export const installRuntimeEndpointReset = (): (() => void) => {
  const unsubscribeWillChange = subscribeRuntimeEndpointWillChange((detail) => {
    prepareAppForRuntimeEndpointChange(detail);
  });
  const unsubscribeChanged = subscribeRuntimeEndpointChanged((detail) => {
    if (isSameRuntimeEndpoint(detail)) return;
    resetAppForRuntimeEndpointChange(detail);
  });
  return () => {
    unsubscribeWillChange();
    unsubscribeChanged();
  };
};

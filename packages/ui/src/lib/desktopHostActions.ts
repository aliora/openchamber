// Host work the desktop shell hands to the main window: redeeming a pairing
// link the user confirmed in the shell's prompt, and focusing a saved host.
// Pairing goes through the same importDesktopHostPairing as Import Link in
// Settings, so a link whose only reachable leg is the relay pairs over the
// tunnel and the saved host keeps both its direct and relay legs.

import { isDesktopMultiHostPage, takePendingDesktopHostActions } from '@/lib/desktop';
import { getInjectedBootOutcome } from '@/lib/desktopBoot';
import { getLocalDesktopOrigin, LOCAL_HOST_ID, runtimeKeyForDesktopHost } from '@/lib/desktopCurrentHost';
import {
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  getDesktopHostApiUrl,
  importDesktopHostPairing,
  normalizeHostUrl,
} from '@/lib/desktopHosts';
import { restoreDesktopRelayRuntime } from '@/lib/desktopRelayRestore';
import { focusRegisteredHost } from '@/lib/hosts/runtime/app-host';
import { windowHostKey } from '@/lib/hosts/runtime/window-host';
import { getRuntimeApiBaseUrl, getRuntimeKey, normalizeRuntimeUrlKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

type HostActionFailure = 'invalid-link' | 'unreachable' | 'failed';

const failureOf = (message: string): HostActionFailure => {
  if (message === 'invalid-connect-link') return 'invalid-link';
  if (message === 'pairing-redeem-failed') return 'unreachable';
  return 'failed';
};

const focusWindowHostAt = (apiBaseUrl: string): boolean => {
  const windowKey = windowHostKey();
  if (!windowKey || normalizeRuntimeUrlKey(apiBaseUrl) !== windowKey) return false;
  return getRuntimeKey() === windowKey || focusRegisteredHost(windowKey);
};

const activateHost = async (hostId: string, options?: { reconnectActive?: boolean }): Promise<void> => {
  const host = (await desktopHostsGet()).hosts.find((entry) => entry.id === hostId);
  if (!host) throw new Error('host-not-found');
  if (host.relay) {
    await restoreDesktopRelayRuntime(host.id, options);
    return;
  }
  const apiBaseUrl = normalizeHostUrl(getDesktopHostApiUrl(host));
  if (!apiBaseUrl) throw new Error('host-not-found');
  if (focusWindowHostAt(apiBaseUrl)) return;
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken: host.clientToken || null,
    requestHeaders: host.requestHeaders || null,
    runtimeKey: runtimeKeyForDesktopHost(host),
    sshForwarded: host.sshForwarded === true,
  });
};

/**
 * Moves the window's focus to a saved host, Local included. A host that already
 * runs beside the others is focused as it is; otherwise Local is reached at its
 * origin, a relay host direct first with the tunnel as fallback, and a direct
 * host at its address. Rejects for a host the shell does not know.
 */
export const switchToDesktopHost = async (hostId: string): Promise<void> => {
  const runtimeKey = hostId === LOCAL_HOST_ID ? 'local' : `host:${hostId}`;
  if (focusRegisteredHost(runtimeKey)) return;
  if (hostId !== LOCAL_HOST_ID) {
    await activateHost(hostId);
    return;
  }
  const localOrigin = getLocalDesktopOrigin();
  if (!localOrigin) throw new Error('host-not-found');
  const clientToken = await desktopLocalClientTokenGet().catch(() => '');
  switchRuntimeEndpoint({ apiBaseUrl: localOrigin, clientToken: clientToken || null, runtimeKey: 'local' });
};

let initialFocusTaken = false;

export const focusInitialDesktopHost = async (): Promise<void> => {
  if (initialFocusTaken || !isDesktopMultiHostPage()) return;
  initialFocusTaken = true;
  const outcome = getInjectedBootOutcome();
  const hostId = outcome?.status === 'ok' ? outcome.initialFocusHostId : undefined;
  if (!hostId) return;
  const runtimeKey = hostId === LOCAL_HOST_ID ? 'local' : `host:${hostId}`;
  if (runtimeKey !== getRuntimeKey()) {
    await switchToDesktopHost(hostId);
    return;
  }
  if (!getRuntimeApiBaseUrl()) await restoreDesktopRelayRuntime(hostId, { reconnectActive: true });
};

const pairAndActivate = async (link: string): Promise<void> => {
  const config = await desktopHostsGet();
  const imported = await importDesktopHostPairing(link, config.hosts);
  await desktopHostsSet({
    hosts: imported.hosts,
    // Pairing adds an instance; it becomes the default only when none is set.
    defaultHostId: config.defaultHostId || imported.hostId,
    initialHostChoiceCompleted: true,
  });
  await activateHost(imported.hostId, { reconnectActive: true });
};

/** Runs every pending pairing in order; one failure does not stop the rest. */
export const runPendingDesktopHostActions = async (
  onFailure: (failure: HostActionFailure) => void,
): Promise<void> => {
  const actions = await takePendingDesktopHostActions();
  for (const action of actions) {
    try {
      await pairAndActivate(action.link);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[desktop] host action failed', action.type, message);
      onFailure(failureOf(message));
    }
  }
};

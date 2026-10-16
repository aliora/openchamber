import type { HostsAPI } from '@openchamber/ui/lib/api/types';
import { isElectronShell } from '@openchamber/ui/lib/desktop';
import { LOCAL_HOST_ID, runtimeKeyForDesktopHost, withLocalDesktopHost } from '@openchamber/ui/lib/desktopCurrentHost';
import {
  desktopHostsGet,
  desktopLocalClientTokenGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  redactSensitiveUrl,
  relayHostDisplayUrl,
  type DesktopHost,
} from '@openchamber/ui/lib/desktopHosts';
import type { HostEndpoint, SavedHost } from '@openchamber/ui/lib/hosts/types';

// Saved hosts for the multi-host sidebar. Only the desktop app saves hosts, and
// only its own pages get their credentials: the shell hands a page served by
// another instance a copy without tokens (`remote-page-policy.mjs`), so that
// page answers unsupported here instead of monitoring with nothing to sign in
// with. Plain web, hosted mobile and the Capacitor app run this same module
// and answer unsupported; the phone keeps its own connections
// (`mobileConnections.ts`).

const PACKAGED_UI_ORIGIN = 'openchamber-ui://app';

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * The page is the desktop app's own UI: the packaged scheme, the local server's
 * origin, or the Vite dev server, which only ever serves the local UI. Mirrors
 * `isLocalPage` in the Electron preload.
 */
export const isLocalDesktopPage = (pageOrigin: string | undefined, localOrigin: string | undefined, devServer: boolean): boolean => {
  if (devServer || pageOrigin === PACKAGED_UI_ORIGIN) return true;
  return Boolean(pageOrigin && localOrigin && originOf(localOrigin) === pageOrigin);
};

export type WebHostsDependencies = {
  isSupported(): boolean;
  readHosts: typeof desktopHostsGet;
  readLocalToken: typeof desktopLocalClientTokenGet;
};

const toEndpoint = (host: DesktopHost): HostEndpoint | null => {
  if (host.id === LOCAL_HOST_ID) {
    const apiUrl = normalizeHostUrl(host.url);
    return apiUrl ? { kind: 'local', apiUrl } : null;
  }
  // A relay-only host has only its display `relay://` URL, which normalizes to null.
  const apiUrl = normalizeHostUrl(getDesktopHostApiUrl(host));
  if (host.relay && apiUrl) return { kind: 'multi', apiUrl, relay: host.relay };
  if (host.relay) return { kind: 'relay', relay: host.relay };
  return apiUrl ? { kind: 'direct', apiUrl } : null;
};

const toSavedHost = (host: DesktopHost): SavedHost[] => {
  const endpoint = toEndpoint(host);
  if (!endpoint) return [];
  return [{
    descriptor: {
      id: host.id,
      label: host.label,
      kind: endpoint.kind,
      displayUrl: endpoint.kind === 'relay' ? relayHostDisplayUrl(endpoint.relay.serverId) : redactSensitiveUrl(endpoint.apiUrl),
      runtimeKey: runtimeKeyForDesktopHost(host),
      // Every saved host is watched; there is no per-host switch yet.
      monitored: true,
    },
    endpoint,
  }];
};

const defaultDependencies: WebHostsDependencies = {
  isSupported: () => isElectronShell() && isLocalDesktopPage(
    globalThis.location?.origin,
    globalThis.window?.__OPENCHAMBER_LOCAL_ORIGIN__,
    import.meta.env.DEV,
  ),
  readHosts: desktopHostsGet,
  readLocalToken: desktopLocalClientTokenGet,
};

export const createWebHostsAPI = (dependencies: WebHostsDependencies = defaultDependencies): HostsAPI => ({
  async listHosts() {
    if (!dependencies.isSupported()) return { status: 'unsupported' };
    const config = await dependencies.readHosts();
    return { status: 'ok', hosts: withLocalDesktopHost(config.hosts, config.localOrigin).flatMap(toSavedHost) };
  },

  async getCredential(hostId) {
    if (!dependencies.isSupported()) return null;
    if (hostId === LOCAL_HOST_ID) {
      const token = await dependencies.readLocalToken();
      return { token: token || null, requestHeaders: {} };
    }
    const host = (await dependencies.readHosts()).hosts.find((entry) => entry.id === hostId);
    if (!host) return null;
    return { token: host.clientToken || null, requestHeaders: host.requestHeaders ?? {} };
  },
});

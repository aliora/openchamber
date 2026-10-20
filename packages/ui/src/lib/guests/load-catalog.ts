import { isVSCodeRuntime } from '@/lib/desktop';
import { defineHostValue, resolveHost } from '@/lib/hosts/runtime/host-bindings';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { useGuestBadgeStore } from './badge-store.ts';
import { parseGuestCatalogJson } from './parse.ts';
import { useGuestsStore } from './store.ts';

const alignCatalogRuntime = (runtimeKey: string): void => {
  const store = useGuestsStore.getState();
  if (store.runtimeKey !== runtimeKey) {
    store.resetForRuntimeSwitch(runtimeKey);
    useGuestBadgeStore.getState().resetForRuntimeSwitch();
  }
};

type CatalogRequest = { runtimeKey: string; request: Promise<void> };

const catalogRequests = defineHostValue<{ inFlight: CatalogRequest | null }>(() => ({ inFlight: null }));

/**
 * One request at a time per runtime: the rail, the composer, and the dialogs
 * all ask on mount. A request still running for the previous server is not
 * reused after a switch; its answer is dropped by the runtime check below,
 * and the new server gets its own request.
 */
export const loadGuestCatalog = (): Promise<void> => {
  const host = resolveHost();
  const runtimeKey = getRuntimeKey();
  const requests = host.run(catalogRequests);
  if (requests.inFlight && requests.inFlight.runtimeKey === runtimeKey) return requests.inFlight.request;
  const request = loadGuestCatalogOnce(host, runtimeKey).finally(() => {
    if (requests.inFlight?.request === request) requests.inFlight = null;
  });
  requests.inFlight = { runtimeKey, request };
  return request;
};

const loadGuestCatalogOnce = async (host: HostRuntime, runtimeKey: string): Promise<void> => {
  host.run(() => alignCatalogRuntime(runtimeKey));

  const store = host.run(useGuestsStore.getState);
  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) {
    store.markUnsupported(runtimeKey);
    return;
  }

  store.markLoading();
  try {
    const response = await host.run(() => runtimeFetch('/api/guests'));
    if (host.run(useGuestsStore.getState).runtimeKey !== runtimeKey) {
      return;
    }
    if (!response.ok) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'http', status: response.status });
      return;
    }
    const content = await response.text().catch(() => null);
    const catalog = content === null ? null : parseGuestCatalogJson(content);
    if (host.run(useGuestsStore.getState).runtimeKey !== runtimeKey) {
      return;
    }
    if (!catalog) {
      store.markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'invalid-response', status: response.status });
      return;
    }
    host.run(useGuestsStore.getState).replaceCatalog(catalog.guests, runtimeKey, catalog.unreadable);
  } catch {
    host.run(useGuestsStore.getState).markFailed(runtimeKey, { method: 'GET', path: '/api/guests', kind: 'network' });
  }
};

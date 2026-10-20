/**
 * Reads OpenCode's integration list once the app has started and the browser
 * is idle, so Settings → Providers opens on it instead of waiting for the
 * read. Mounted by the desktop/web/VS Code app only: the phone layout reads
 * the list when Settings opens, and so does any window talking to its server
 * through the relay, where every byte is paid.
 */
import React from 'react';

import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { prefetchIntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { POPULAR_PROVIDERS } from '@/components/sections/providers/connectableProviders';

const prefetch = () => {
  if (isRelayModeActive()) return;
  prefetchIntegrationCatalog();
  preloadProviderLogos(POPULAR_PROVIDERS.map((provider) => provider.id));
};

/** `ready` is true once the app is initialized and connected to OpenCode; `hostId` is the focused host. */
export const useIntegrationCatalogPrefetch = (ready: boolean, hostId: string): void => {
  React.useEffect(() => {
    if (!ready) return;
    // Safari has no requestIdleCallback.
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 10_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timeout = setTimeout(prefetch, 3000);
    return () => clearTimeout(timeout);
  }, [ready, hostId]);
};

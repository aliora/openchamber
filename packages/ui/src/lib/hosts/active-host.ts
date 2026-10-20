import { normalizeRuntimeUrlKey } from '@/lib/runtime-switch';
import type { SavedHost } from './types';

/**
 * Whether the window is on this host. A window that knows the host only by its
 * address is keyed `url:<address>`: one opened for a host (Cmd or Ctrl on its
 * session, Open in new window), or the main window started on a remote default
 * host, which reads its boot outcome only after the runtime key is set. It is
 * on that host all the same.
 */
export const isActiveHost = (host: SavedHost, activeKey: string): boolean => {
  if (host.descriptor.runtimeKey === activeKey) return true;
  if (!activeKey.startsWith('url:') || host.endpoint.kind === 'relay') return false;
  return normalizeRuntimeUrlKey(host.endpoint.apiUrl) === activeKey;
};

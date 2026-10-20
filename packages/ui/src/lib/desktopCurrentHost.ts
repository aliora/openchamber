import type { DesktopHost } from '@/lib/desktopHosts';

export const LOCAL_HOST_ID = 'local';

export const LOCAL_HOST_DEFAULT_LABEL = 'Local';

/**
 * Where this app's own server listens, as the desktop shell reports it. Empty
 * when the shell runs no local server (`OPENCHAMBER_SKIP_LOCAL_SERVER=1`) or
 * has not reported one to this page yet. The page's own origin cannot stand in
 * for it. On desktop, that origin is the packaged UI's scheme or another
 * instance whose page the window shows.
 */
export const getLocalDesktopOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__?.trim() || '';
};

/**
 * The configured instances with Local in front, when the shell reported where
 * its local server listens. Without a local server, an entry for it would
 * point at nothing.
 */
export const withLocalDesktopHost = (
  hosts: DesktopHost[],
  localOrigin: string | null | undefined,
  localLabel?: string | null,
): DesktopHost[] => (
  localOrigin ? [{ id: LOCAL_HOST_ID, label: localLabel || LOCAL_HOST_DEFAULT_LABEL, url: localOrigin }, ...hosts] : hosts
);

export const runtimeKeyForDesktopHost = (host: DesktopHost): string => {
  if (host.id === LOCAL_HOST_ID) return 'local';
  return `host:${host.id}`;
};

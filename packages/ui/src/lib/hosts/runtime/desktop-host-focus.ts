import { LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import type { HostRegistry } from './types';

const DESKTOP_HOST_KEY_PREFIX = 'host:';

export const desktopHostIdOf = (runtimeKey: string): string | null => {
  if (runtimeKey === 'local') return LOCAL_HOST_ID;
  if (!runtimeKey.startsWith(DESKTOP_HOST_KEY_PREFIX)) return null;
  return runtimeKey.slice(DESKTOP_HOST_KEY_PREFIX.length) || null;
};

type FocusPersistenceOptions = {
  registry: HostRegistry;
  write(hostId: string): Promise<boolean>;
  delayMs: number;
  schedule(run: () => void, delayMs: number): () => void;
};

export const persistFocusedDesktopHost = ({ registry, write, delayMs, schedule }: FocusPersistenceOptions): (() => void) => {
  const focusedHostId = (): string | null => (registry.list().length > 0 ? desktopHostIdOf(registry.focused().id) : null);
  let persisted = focusedHostId();
  let cancel: (() => void) | null = null;
  const unsubscribe = registry.subscribe(() => {
    const hostId = focusedHostId();
    if (!hostId || hostId === persisted) return;
    persisted = hostId;
    cancel?.();
    cancel = schedule(() => {
      cancel = null;
      void write(hostId).catch(() => false);
    }, delayMs);
  });
  return () => {
    unsubscribe();
    cancel?.();
  };
};

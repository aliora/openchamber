import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { IconName } from '@/components/icon/icons';
import { useHostsStore } from './hosts-store';
import type { HostKind } from './types';

export const HOST_ICON_CHOICES = [
  'computer',
  'macbook',
  'apple',
  'window',
  'server',
  'hard-drive-2',
  'terminal-window',
  'smartphone',
  'home',
  'home-office',
  'cloud',
  'gamepad',
] as const satisfies readonly IconName[];

const LOCAL_RUNTIME_KEY = 'local';

type HostIconStore = {
  /** The icon the user picked per host, by runtime key. Kept on this device. */
  icons: Readonly<Record<string, IconName>>;
  setIcon: (runtimeKey: string, icon: IconName | null) => void;
};

export const useHostIconStore = create<HostIconStore>()(
  persist(
    (set) => ({
      icons: {},
      setIcon: (runtimeKey, icon) => set((state) => {
        const { [runtimeKey]: _replaced, ...rest } = state.icons;
        return { icons: icon ? { ...rest, [runtimeKey]: icon } : rest };
      }),
    }),
    { name: 'host-icons', version: 1 },
  ),
);

const defaultHostIcon = (kind: HostKind | null): IconName => (kind === null || kind === 'local' ? 'computer' : 'server');

export const useHostIcon = (runtimeKey: string, kind: HostKind | null): IconName => (
  useHostIconStore((state) => state.icons[runtimeKey]) ?? defaultHostIcon(kind)
);

/** The icon of the host this window is connected to. */
export const useActiveHostIcon = (): IconName => {
  const runtimeKey = useHostsStore((state) => state.activeHost?.runtimeKey ?? LOCAL_RUNTIME_KEY);
  const kind = useHostsStore((state) => state.activeHost?.kind ?? null);
  return useHostIcon(runtimeKey, kind);
};

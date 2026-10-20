import { currentHostKey } from '@/lib/hosts/runtime/host-key';
import { isMultiHostRuntimeEnabled } from '@/lib/hosts/runtime/multi-host-flag';

type HostDirectoryEntry = 'lastDirectory' | 'homeDirectory';

export const hostDirectoryStorageKey = (entry: HostDirectoryEntry, hostKey: string = currentHostKey()): string => (
  isMultiHostRuntimeEnabled() ? `${entry}:${encodeURIComponent(hostKey)}` : entry
);

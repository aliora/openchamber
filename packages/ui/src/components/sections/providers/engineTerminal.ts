import React from 'react';

import { useRunInTerminal, useTerminalCommandOptions, type RunInTerminal } from '@/hooks/useRunInTerminal';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { focusRegisteredHost } from '@/lib/hosts/runtime/app-host';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';
import { runInTerminal } from '@/lib/runInTerminal';

export const useHostTerminalRunner = (host: HostRuntime): RunInTerminal | null => {
  const focusedId = useFocusedHostId();
  const focusedRunner = useRunInTerminal();
  const { terminal, runtime } = useRuntimeAPIs();
  const createOptions = useTerminalCommandOptions();
  return React.useMemo(() => {
    if (host.id === focusedId) return focusedRunner;
    if (runtime.isVSCode) return null;
    return async (command: string, ownerId: string) => {
      const home = await host.client.getFilesystemHome();
      if (!home || host.disposed || !focusRegisteredHost(host.id)) throw new Error();
      return host.run(() => runInTerminal({ terminal, command, target: { directory: home, panelDirectory: null }, ownerId, createOptions }));
    };
  }, [createOptions, focusedId, focusedRunner, host, runtime.isVSCode, terminal]);
};

import * as React from 'react';
import { isMultiHostRuntimeEnabled } from '@/lib/hosts/runtime/multi-host-flag';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { runCompatibilityCheck, takeCompatibilityCheck, type CompatibilityCheck } from './codeCliCompatibilityCheck';

export const CodeCliCompatibilityGate: React.FC<React.PropsWithChildren<{ enabled?: boolean }>> = ({ children, enabled = true }) => {
  React.useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    let generation = 0;
    const incompatibleHosts = new Map<string, boolean>();
    const check = (request: CompatibilityCheck, runtimeKey: string) => {
      const revision = ++generation;
      request
        .then((result) => {
          incompatibleHosts.set(runtimeKey, result?.state === 'incompatible');
          if (result?.state === 'incompatible' && mounted && revision === generation) {
            useUIStore.getState().setEngineSetupOpen(true);
          }
        })
        .catch(() => undefined);
    };
    check(takeCompatibilityCheck(), getRuntimeKey());
    const unsubscribe = subscribeRuntimeEndpointChanged((detail) => {
      const known = incompatibleHosts.get(detail.runtimeKey);
      if (known !== undefined && detail.runtimeKey !== detail.previousRuntimeKey && isMultiHostRuntimeEnabled()) {
        generation += 1;
        if (known) useUIStore.getState().setEngineSetupOpen(true);
        return;
      }
      check(runCompatibilityCheck(), detail.runtimeKey);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [enabled]);

  return <>{children}</>;
};

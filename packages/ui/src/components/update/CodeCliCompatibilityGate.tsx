import * as React from 'react';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { runCompatibilityCheck, takeCompatibilityCheck, type CompatibilityCheck } from './codeCliCompatibilityCheck';

export const CodeCliCompatibilityGate: React.FC<React.PropsWithChildren<{ enabled?: boolean }>> = ({ children, enabled = true }) => {
  React.useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    let generation = 0;
    const check = (request: CompatibilityCheck) => {
      const revision = ++generation;
      request
        .then((result) => {
          if (result?.state === 'incompatible' && mounted && revision === generation) {
            useUIStore.getState().setEngineSetupOpen(true);
          }
        })
        .catch(() => undefined);
    };
    check(takeCompatibilityCheck());
    const unsubscribe = subscribeRuntimeEndpointChanged(() => check(runCompatibilityCheck()));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [enabled]);

  return <>{children}</>;
};

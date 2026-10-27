import React from 'react';
import { isAppearanceEngineId, resolveEngineView, type EngineView } from '@/lib/engineAppearance';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useUIStore } from '@/stores/useUIStore';

/** The engine that runs a provider's models on this server, with its chosen name and logo; null where no engine does. */
export const useEngineView = (providerId: string | null | undefined): EngineView | null => {
  const engine = useEngineControlsStore((state) => (
    state.catalog?.engines.find((entry) => entry.providerID === providerId)?.engine
  ));
  const appearance = useUIStore((state) => state.engineAppearance);

  React.useEffect(() => {
    const { status, load } = useEngineControlsStore.getState();
    if (status === 'idle') void load();
  }, []);

  return React.useMemo(
    () => (isAppearanceEngineId(engine) ? resolveEngineView(engine, appearance) : null),
    [engine, appearance],
  );
};

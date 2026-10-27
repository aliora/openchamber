import React from 'react';
import { findCatalogModel } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEngineView } from './useEngineView';

/** The client a session runs on and the name of the model it last used. */
export const useSessionClient = (providerId: string | null | undefined, modelId: string | null | undefined) => {
  const engine = useEngineView(providerId);
  const providers = useConfigStore((state) => state.providers);
  const modelName = React.useMemo(() => {
    if (!modelId) return null;
    const provider = providers.find((entry) => entry.id === providerId);
    return findCatalogModel(provider?.models, modelId)?.name ?? modelId;
  }, [providers, providerId, modelId]);
  return { engine, modelName };
};

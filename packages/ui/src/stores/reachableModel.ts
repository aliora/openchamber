import { findCatalogModel } from '@/lib/opencode/model';
import type { UnavailableProviders } from './useEngineReadinessStore';

type ModelChoice = { providerId: string; modelId: string };

type CatalogProvider = {
  id: string;
  models: ReadonlyArray<{ id: string; modelID: string }>;
};

export type ModelReachability = {
  catalogDefaults: Readonly<Record<string, string>>;
  readiness: {
    ready: ReadonlySet<string>;
    unavailable: UnavailableProviders;
  };
};

const providerDefault = (provider: CatalogProvider, catalogDefaults: Readonly<Record<string, string>>): ModelChoice | null => {
  const model = findCatalogModel(provider.models, catalogDefaults[provider.id] ?? '') ?? provider.models[0];
  return model ? { providerId: provider.id, modelId: model.modelID } : null;
};

export const resolveReachableModel = (
  choice: ModelChoice,
  providers: readonly CatalogProvider[],
  { catalogDefaults, readiness }: ModelReachability,
): ModelChoice => {
  if (readiness.ready.has(choice.providerId)) {
    const provider = providers.find((item) => item.id === choice.providerId);
    if (!provider || findCatalogModel(provider.models, choice.modelId)) return choice;
    return providerDefault(provider, catalogDefaults) ?? choice;
  }
  if (!readiness.unavailable.has(choice.providerId)) return choice;
  for (const providerId of readiness.ready) {
    const provider = providers.find((item) => item.id === providerId);
    const fallback = provider && providerDefault(provider, catalogDefaults);
    if (fallback) return fallback;
  }
  return choice;
};

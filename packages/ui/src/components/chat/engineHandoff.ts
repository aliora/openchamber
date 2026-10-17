import type { EngineControlsCatalog } from '@/stores/useEngineControlsStore';

const NO_PROVIDERS: ReadonlySet<string> = new Set();

export const findHandoffProviders = (
    catalog: EngineControlsCatalog | null,
    sessionProviderID: string | null | undefined,
    hasHistory: boolean,
): ReadonlySet<string> => {
    if (!catalog || !hasHistory || !sessionProviderID) return NO_PROVIDERS;
    const providerIDs = catalog.engines.map((engine) => engine.providerID);
    if (!providerIDs.includes(sessionProviderID)) return NO_PROVIDERS;
    return new Set(providerIDs.filter((providerID) => providerID !== sessionProviderID));
};

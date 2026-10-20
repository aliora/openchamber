import React from 'react';
import { createStore } from 'zustand/vanilla';
import { devtools } from 'zustand/middleware';
import { defineHostStore, defineHostValue } from '@/lib/hosts/runtime/host-bindings';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import type { DesktopSettings } from '@/lib/desktop';
import { getDefaultModels } from '@/lib/quota/model-families';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { fetchQuota } from '@/lib/quota/fetchQuota';
import { isTransientRuntimeKey } from '@/lib/runtime-switch';
import { currentHostKey } from '@/lib/hosts/runtime/host-key';
import { useConfigStore } from '@/stores/useConfigStore';

const QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
type QuotaLoads = {
  // Quotas and their display settings are read from the connected OpenChamber
  // instance, so both belong to that instance. Bumped on every reset so a
  // response in flight for the previous instance cannot land in the new one.
  generation: number;
  inFlightRuntimeLoad: Promise<void> | null;
  requests: Map<QuotaProviderId, { controller: AbortController; promise: Promise<boolean> }>;
};

const quotaLoads = defineHostValue<QuotaLoads>(() => ({ generation: 0, inFlightRuntimeLoad: null, requests: new Map() }));
let quotaAutoRefreshConsumers = 0;
let quotaAutoRefreshInterval: number | null = null;

interface QuotaSettingsState {
  displayMode: 'usage' | 'remaining';
  dropdownProviderIds: QuotaProviderId[];
  selectedModels: Record<string, string[]>;  // Map of providerId -> selected model names
  expandedFamilies: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
}

interface QuotaStore extends QuotaSettingsState {
  results: ProviderResult[];
  /** Instance whose quotas `results` describes, or `null` when nothing is loaded. */
  loadedRuntimeKey: string | null;
  selectedProviderId: QuotaProviderId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;
  /** Refresh failures are not authoritative provider configuration or usage. */
  refreshErrors: Partial<Record<QuotaProviderId, string>>;

  loadSettings: () => Promise<void>;
  fetchAllQuotas: () => Promise<void>;
  /** Resolves true when at least one provider answered — see `ensureLoadedForRuntime`. */
  fetchQuotas: (providerIds: QuotaProviderId[], options?: { invalidate?: boolean }) => Promise<boolean>;
  /** Resolves true when the instance answered, false on a transport failure. */
  fetchProviderQuota: (providerId: QuotaProviderId, invalidate?: boolean) => Promise<boolean>;
  setSelectedProvider: (providerId: QuotaProviderId | null) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: string, availableModels: string[]) => void;
  /**
   * Load settings and quotas once per instance, when that instance is ready.
   *
   * Providers report themselves as configured only after the instance can read
   * their credentials, which on a remote instance is not true the moment the UI
   * mounts. A fetch fired at mount therefore answers "nothing configured", and
   * because every provider then has a result, no consumer asks again until the
   * three-minute refresh — which is why Usage stayed missing from the
   * work-status panel until Settings -> Usage forced a fresh fetch.
   */
  ensureLoadedForRuntime: () => Promise<void>;
  resetForRuntimeSwitch: () => void;
}

const parseSettings = (data: DesktopSettings): QuotaSettingsState => {
  const allProviderIds = QUOTA_PROVIDERS.map((provider) => provider.id);
  const displayMode = data.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const dropdownProviderIds = data.usageDropdownProviders
    ? data.usageDropdownProviders.filter((entry): entry is QuotaProviderId =>
        allProviderIds.some((id) => id === entry)
      )
    : allProviderIds;

  return {
    displayMode,
    dropdownProviderIds,
    // Map of providerId -> selected model names
    selectedModels: data.usageSelectedModels ?? {},
    // Expanded families (inverted collapsed logic for header dropdown)
    expandedFamilies: data.usageExpandedFamilies ?? {},
  };
};

const defaultQuotaSettings = (): QuotaSettingsState => ({
  displayMode: 'usage',
  dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
  selectedModels: {},
  expandedFamilies: {},
});

const loadSettingsFromRuntime = async (): Promise<QuotaSettingsState> => {
  const settings = await loadDesktopSettings();
  return settings ? parseSettings(settings) : defaultQuotaSettings();
};

export const useQuotaStore = defineHostStore<QuotaStore>('quota', (host) => createStore<QuotaStore>()(
  devtools(
    (set, get) => ({
      results: [],
      loadedRuntimeKey: null,
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      refreshErrors: {},
      displayMode: 'usage',
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      selectedModels: {},
      expandedFamilies: {},

      loadSettings: async () => {
        const loads = host.run(quotaLoads);
        const generation = loads.generation;
        try {
          const settings = await host.run(loadSettingsFromRuntime);
          if (generation !== loads.generation) return;
          set(settings);
        } catch (error) {
          console.warn('Failed to load usage settings:', error);
        }
      },

      fetchQuotas: async (providerIds, { invalidate = false } = {}) => {
        const loads = host.run(quotaLoads);
        const generation = loads.generation;
        try {
          const answered = await Promise.all(
            providerIds.map((providerId) => get().fetchProviderQuota(providerId, invalidate))
          );
          if (generation !== loads.generation) return false;
          return answered.some(Boolean);
        } catch (error) {
          if (generation !== loads.generation) return false;
          const message = error instanceof Error ? error.message : 'Failed to fetch quotas';
          set({ error: message });
          return false;
        }
      },

      fetchAllQuotas: async () => {
        await get().fetchQuotas(QUOTA_PROVIDERS.map((provider) => provider.id));
      },

      fetchProviderQuota: async (providerId, invalidate = false) => {
        // Concurrent callers share one request per provider. `invalidate` is how
        // a provider-account switch says the shared request, and any sample it
        // produces, describe the account being switched away from.
        const loads = host.run(quotaLoads);
        const quotaRequests = loads.requests;
        const existing = quotaRequests.get(providerId);
        if (existing && !invalidate) return existing.promise;
        if (existing) {
          existing.controller.abort();
          quotaRequests.delete(providerId);
        }
        const generation = loads.generation;
        const controller = new AbortController();
        const promise = Promise.resolve().then(async () => {
          try {
            const result = await host.run(() => fetchQuota(providerId, { signal: controller.signal }));
            if (generation !== loads.generation) return false;
            // A reachable instance can still report that its provider request
            // failed. Configuration is known, but there is no new usage sample.
            if (!result.ok && result.configured) {
              const message = result.error || 'Failed to fetch quota';
              set(state => {
                const previous = state.results.find(entry => entry.providerId === providerId);
                // Preserving the last sample keeps a periodic refresh from
                // blanking the surface on a blip. After a switch it is wrong:
                // that sample belongs to the account just left, so keeping it
                // shows one account's usage as if it were the new account's.
                const keepPrevious = previous?.configured && !invalidate;
                const results = keepPrevious
                  ? state.results
                  : [...state.results.filter(entry => entry.providerId !== providerId), result];
                return { results, refreshErrors: { ...state.refreshErrors, [providerId]: message }, error: message };
              });
              return true;
            }
            set((state) => {
              const refreshErrors = { ...state.refreshErrors };
              delete refreshErrors[providerId];
              const results = state.results.filter(entry => entry.providerId !== providerId);
              results.push(result);
              return { results, refreshErrors, error: Object.values(refreshErrors)[0] ?? null, lastUpdated: Date.now() };
            });
            return true;
          } catch (error) {
            if (generation !== loads.generation) return false;
            // An abort is this store superseding its own request, not the
            // instance failing. Recording it would report a refresh error right
            // after a switch, over the sample being replaced.
            if (controller.signal.aborted) return false;
            const message = error instanceof Error ? error.message : 'Failed to fetch quota';
            set(state => ({ refreshErrors: { ...state.refreshErrors, [providerId]: message }, error: message }));
            return false;
          } finally {
            if (quotaRequests.get(providerId)?.controller === controller) quotaRequests.delete(providerId);
            if (generation === loads.generation) {
              // A superseded request finishes while its replacement still runs;
              // the provider stays fetching until the replacement settles too.
              set((state) => ({
                isFetchingProvider: { ...state.isFetchingProvider, [providerId]: quotaRequests.has(providerId) },
                isLoading: quotaRequests.size > 0,
              }));
            }
          }
        });
        quotaRequests.set(providerId, { controller, promise });
        set(state => ({ isLoading: true, isFetchingProvider: { ...state.isFetchingProvider, [providerId]: true } }));
        return promise;
      },

      ensureLoadedForRuntime: async () => {
        const runtimeKey = currentHostKey();
        if (isTransientRuntimeKey(runtimeKey)) return;
        // Wait for the instance to report itself initialised. Asking earlier
        // gets an honest-looking "not configured" for every provider, which is
        // then cached as if it were the answer.
        if (!host.run(useConfigStore.getState).isInitialized) return;
        if (get().loadedRuntimeKey === runtimeKey) return;
        const loads = host.run(quotaLoads);
        if (loads.inFlightRuntimeLoad) return loads.inFlightRuntimeLoad;

        const generation = loads.generation;
        loads.inFlightRuntimeLoad = (async () => {
          await get().loadSettings();
          if (generation !== loads.generation) return;
          const { dropdownProviderIds, fetchQuotas } = get();
          if (dropdownProviderIds.length === 0) return;
          const answered = await fetchQuotas(dropdownProviderIds);
          // Mark the instance loaded only once it actually answered. Claiming it
          // up front meant a load that failed on a cold or briefly unreachable
          // instance was never attempted again — Usage would stay empty until
          // the three-minute refresh, or forever after a switch.
          if (answered && generation === loads.generation) set({ loadedRuntimeKey: runtimeKey });
        })().finally(() => { if (generation === loads.generation) loads.inFlightRuntimeLoad = null; });

        return loads.inFlightRuntimeLoad;
      },

      resetForRuntimeSwitch: () => {
        const loads = host.run(quotaLoads);
        loads.generation += 1;
        for (const request of loads.requests.values()) request.controller.abort();
        loads.requests.clear();
        loads.inFlightRuntimeLoad = null;
        set({
          // Display mode, the provider selection and the per-provider model
          // picks all come from the instance's own settings, and
          // `dropdownProviderIds` decides what gets fetched — carrying them
          // over would query the new instance through the old one's choices.
          ...defaultQuotaSettings(),
          results: [],
          loadedRuntimeKey: null,
          selectedProviderId: null,
          isLoading: false,
          isFetchingProvider: {},
          lastUpdated: null,
          error: null,
          refreshErrors: {},
        });
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setDropdownProviderIds: (providerIds) => set({ dropdownProviderIds: providerIds }),

      setSelectedModels: (providerId, modelNames) => {
        set((state) => ({
          selectedModels: { ...state.selectedModels, [providerId]: modelNames }
        }));
      },

      toggleModelSelected: (providerId, modelName) => {
        set((state) => {
          const currentSelected = state.selectedModels[providerId] ?? [];
          const isSelected = currentSelected.includes(modelName);
          const nextSelected = isSelected
            ? currentSelected.filter((m) => m !== modelName)
            : [...currentSelected, modelName];
          return {
            selectedModels: { ...state.selectedModels, [providerId]: nextSelected }
          };
        });
      },

      setExpandedFamilies: (providerId, familyIds) => {
        set((state) => ({
          expandedFamilies: { ...state.expandedFamilies, [providerId]: familyIds }
        }));
        // Persist
        void host.run(() => updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies }));
      },

      toggleFamilyExpanded: (providerId, familyId) => {
        set((state) => {
          const currentExpanded = state.expandedFamilies[providerId] ?? [];
          const isExpanded = currentExpanded.includes(familyId);
          const nextExpanded = isExpanded
            ? currentExpanded.filter((id) => id !== familyId)
            : [...currentExpanded, familyId];
          return {
            expandedFamilies: { ...state.expandedFamilies, [providerId]: nextExpanded }
          };
        });
        // Persist
        void host.run(() => updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies }));
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        // Only apply if no prior selections exist
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        // Persist
        void host.run(() => updateDesktopSettings({ usageSelectedModels: get().selectedModels }));
      },
    }),
    { name: 'quota-store' }
  )
));

export const useQuotaAutoRefresh = () => {
  React.useEffect(() => {
    quotaAutoRefreshConsumers += 1;
    if (quotaAutoRefreshInterval === null) {
      quotaAutoRefreshInterval = window.setInterval(() => {
        const { dropdownProviderIds, fetchQuotas } = useQuotaStore.getState();
        if (dropdownProviderIds.length > 0) {
          void fetchQuotas(dropdownProviderIds);
        }
      }, QUOTA_REFRESH_INTERVAL_MS);
    }

    return () => {
      quotaAutoRefreshConsumers -= 1;
      if (quotaAutoRefreshConsumers === 0 && quotaAutoRefreshInterval !== null) {
        window.clearInterval(quotaAutoRefreshInterval);
        quotaAutoRefreshInterval = null;
      }
    };
  }, []);
};

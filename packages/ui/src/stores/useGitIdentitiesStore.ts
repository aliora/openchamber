import { createStore } from 'zustand/vanilla';
import { devtools } from 'zustand/middleware';
import { z } from 'zod';
import {
  getGitIdentities,
  createGitIdentity,
  updateGitIdentity,
  deleteGitIdentity,
  getGlobalGitIdentity,
} from '@/lib/gitApi';
import type { GitIdentityProfile } from '@/lib/api/types';
import {
  gitIdentityProfileIdSchema,
  gitIdentityProfileSchema,
  gitIdentityProfilesSchema,
  gitIdentitySummarySchema,
} from '@/lib/api/git-identity';
import { loadDesktopSettings, reportSettingsSaveState, updateDesktopSettings } from '@/lib/persistence';
import { defineHostStore, defineHostValue } from '@/lib/hosts/runtime/host-bindings';
import { currentHostKey } from '@/lib/hosts/runtime/host-key';
import { portableFanOut } from '@/lib/settings/portable-sync';

export type { GitIdentityProfile } from '@/lib/api/types';

interface GitIdentitiesStore {
  selectedProfileId: string | null;
  defaultGitIdentityId: string | null;
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null;
  isLoading: boolean;

  setSelectedProfile: (id: string | null) => void;
  loadProfiles: () => Promise<boolean>;
  loadGlobalIdentity: () => Promise<boolean>;
  loadDefaultGitIdentityId: () => Promise<boolean>;
  setDefaultGitIdentityId: (id: string | null) => Promise<boolean>;
  createProfile: (profile: Omit<GitIdentityProfile, 'id'> & { id?: string }) => Promise<boolean>;
  updateProfile: (id: string, updates: Partial<GitIdentityProfile>) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  getProfileById: (id: string) => GitIdentityProfile | undefined;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type RuntimeToken = {
  runtimeKey: string;
  generation: number;
};

type IdentityRequests = {
  runtimeGeneration: number;
  activeRuntimeKey: string;
  profilesLoadGeneration: number;
  profilesMutationRevision: number;
  globalIdentityLoadGeneration: number;
  defaultIdentityLoadGeneration: number;
  defaultIdentityMutationGeneration: number;
  profileMutationGenerations: Map<string, number>;
};

const identityRequests = defineHostValue<IdentityRequests>(() => ({
  runtimeGeneration: 0,
  activeRuntimeKey: currentHostKey(),
  profilesLoadGeneration: 0,
  profilesMutationRevision: 0,
  globalIdentityLoadGeneration: 0,
  defaultIdentityLoadGeneration: 0,
  defaultIdentityMutationGeneration: 0,
  profileMutationGenerations: new Map(),
}));

const captureRuntime = (requests: IdentityRequests): RuntimeToken => ({
  runtimeKey: currentHostKey(),
  generation: requests.runtimeGeneration,
});

const isRuntimeCurrent = (requests: IdentityRequests, token: RuntimeToken): boolean => (
  token.runtimeKey === currentHostKey()
  && token.runtimeKey === requests.activeRuntimeKey
  && token.generation === requests.runtimeGeneration
);

const startProfileMutation = (requests: IdentityRequests, id: string): RuntimeToken & { mutationGeneration: number } => {
  const mutationGeneration = (requests.profileMutationGenerations.get(id) ?? 0) + 1;
  requests.profileMutationGenerations.set(id, mutationGeneration);
  requests.profilesMutationRevision += 1;
  return { ...captureRuntime(requests), mutationGeneration };
};

const isProfileMutationCurrent = (
  requests: IdentityRequests,
  token: RuntimeToken & { mutationGeneration: number },
  id: string,
): boolean => isRuntimeCurrent(requests, token) && requests.profileMutationGenerations.get(id) === token.mutationGeneration;

const defaultIdentityIdSchema = z.union([gitIdentityProfileIdSchema, z.literal('')])
  .nullable()
  .transform((value) => value || null);

export const useGitIdentitiesStore = defineHostStore<GitIdentitiesStore>('git-identities', (host) => createStore<GitIdentitiesStore>()(
  devtools(
    (set, get) => ({
      selectedProfileId: null,
      defaultGitIdentityId: null,
      profiles: [],
      globalIdentity: null,
      isLoading: false,

      setSelectedProfile: (id) => set({ selectedProfileId: id }),

      loadProfiles: async () => {
        const requests = host.run(identityRequests);
        const runtime = captureRuntime(requests);
        const loadGeneration = ++requests.profilesLoadGeneration;
        const mutationRevision = requests.profilesMutationRevision;
        set({ isLoading: true });
        try {
          const profiles = gitIdentityProfilesSchema.parse(await host.run(getGitIdentities));
          if (!isRuntimeCurrent(requests, runtime) || loadGeneration !== requests.profilesLoadGeneration) return false;
          if (mutationRevision === requests.profilesMutationRevision) set({ profiles, isLoading: false });
          else set({ isLoading: false });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(requests, runtime) || loadGeneration !== requests.profilesLoadGeneration) return false;
          console.error('Failed to load git identity profiles:', error);
          set({ isLoading: false });
          return false;
        }
      },

      loadGlobalIdentity: async () => {
        const requests = host.run(identityRequests);
        const runtime = captureRuntime(requests);
        const loadGeneration = ++requests.globalIdentityLoadGeneration;
        try {
          const raw = await host.run(getGlobalGitIdentity);
          const data = raw === null ? null : gitIdentitySummarySchema.parse(raw);
          if (!isRuntimeCurrent(requests, runtime) || loadGeneration !== requests.globalIdentityLoadGeneration) return false;
          // The System identity is offered whether or not this machine has an
          // author configured: it is how a person says no override applies
          // here, and a machine with no author still has to be able to clone.
          set({
            globalIdentity: {
              id: 'global',
              // The display name is the product's word for it, resolved where
              // it is rendered; the author's own name is the safe fallback.
              name: data?.userName ?? '',
              userName: data?.userName ?? '',
              userEmail: data?.userEmail ?? '',
              color: 'info',
              icon: 'fingerprint',
            },
          });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(requests, runtime) || loadGeneration !== requests.globalIdentityLoadGeneration) return false;
          console.error('Failed to load global git identity:', error);
          return false;
        }
      },

      loadDefaultGitIdentityId: async () => {
        const requests = host.run(identityRequests);
        const runtime = captureRuntime(requests);
        const loadGeneration = ++requests.defaultIdentityLoadGeneration;
        const mutationGeneration = requests.defaultIdentityMutationGeneration;
        try {
          // Shared settings loading owns the runtime API call, the HTTP
          // fallback, caching and runtime-context invalidation; the generation
          // guards below still reject a read a newer load or write outran.
          const settings = await host.run(loadDesktopSettings);
          if (!isRuntimeCurrent(requests, runtime)) return false;
          const defaultId = defaultIdentityIdSchema.parse(settings?.defaultGitIdentityId ?? null);
          if (loadGeneration !== requests.defaultIdentityLoadGeneration
            || mutationGeneration !== requests.defaultIdentityMutationGeneration) return false;
          set({ defaultGitIdentityId: defaultId });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(requests, runtime) || loadGeneration !== requests.defaultIdentityLoadGeneration) return false;
          console.error('Failed to load default git identity setting:', error);
          return false;
        }
      },

      setDefaultGitIdentityId: async (id) => {
        const requests = host.run(identityRequests);
        const runtime = captureRuntime(requests);
        const mutationGeneration = ++requests.defaultIdentityMutationGeneration;
        const value = defaultIdentityIdSchema.parse(id);
        try {
          const committed = value;
          await host.run(() => updateDesktopSettings({ defaultGitIdentityId: value ?? '' }));
          if (!isRuntimeCurrent(requests, runtime) || mutationGeneration !== requests.defaultIdentityMutationGeneration) return false;
          set({ defaultGitIdentityId: committed });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(requests, runtime) || mutationGeneration !== requests.defaultIdentityMutationGeneration) return false;
          console.error('Failed to save default git identity setting:', error);
          return false;
        }
      },

      createProfile: async (profileData) => {
        const profile: GitIdentityProfile = {
          ...profileData,
          id: profileData.id || `profile-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          color: profileData.color || 'keyword',
          icon: profileData.icon || 'branch',
        };
        const requests = host.run(identityRequests);
        const token = startProfileMutation(requests, profile.id);
        try {
          reportSettingsSaveState('saving');
          const created = gitIdentityProfileSchema.parse(await host.run(() => createGitIdentity(profile)));
          if (created.id !== profile.id) throw new Error('Created Git identity profile ID does not match the request');
          portableFanOut.changed('gitIdentities', created.id, host.id);
          if (!isProfileMutationCurrent(requests, token, profile.id)) return false;
          set((state) => ({ profiles: [...state.profiles.filter((entry) => entry.id !== created.id), created] }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(requests, token, profile.id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to create git identity profile:', error);
          return false;
        }
      },

      updateProfile: async (id, updates) => {
        const existing = get().profiles.find((profile) => profile.id === id);
        if (!existing) return false;
        const requests = host.run(identityRequests);
        const token = startProfileMutation(requests, id);
        try {
          reportSettingsSaveState('saving');
          const updated = gitIdentityProfileSchema.parse(await host.run(() => updateGitIdentity(id, { ...existing, ...updates, id })));
          if (updated.id !== id) throw new Error('Updated Git identity profile ID does not match the request');
          portableFanOut.changed('gitIdentities', id, host.id);
          if (!isProfileMutationCurrent(requests, token, id)) return false;
          set((state) => ({ profiles: state.profiles.map((profile) => profile.id === id ? updated : profile) }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(requests, token, id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to update git identity profile:', error);
          return false;
        }
      },

      deleteProfile: async (id) => {
        const requests = host.run(identityRequests);
        const token = startProfileMutation(requests, id);
        try {
          reportSettingsSaveState('saving');
          await host.run(() => deleteGitIdentity(id));
          portableFanOut.removed('gitIdentities', id, host.id);
          if (!isProfileMutationCurrent(requests, token, id)) return false;
          set((state) => ({
            profiles: state.profiles.filter((profile) => profile.id !== id),
            selectedProfileId: state.selectedProfileId === id ? null : state.selectedProfileId,
            defaultGitIdentityId: state.defaultGitIdentityId === id ? null : state.defaultGitIdentityId,
          }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(requests, token, id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to delete git identity profile:', error);
          return false;
        }
      },

      getProfileById: (id) => id === 'global'
        ? get().globalIdentity || undefined
        : get().profiles.find((profile) => profile.id === id),

      resetForRuntimeSwitch: (runtimeKey) => {
        const requests = host.run(identityRequests);
        requests.runtimeGeneration += 1;
        requests.activeRuntimeKey = runtimeKey;
        requests.profilesLoadGeneration += 1;
        requests.globalIdentityLoadGeneration += 1;
        requests.defaultIdentityLoadGeneration += 1;
        requests.defaultIdentityMutationGeneration += 1;
        requests.profilesMutationRevision += 1;
        requests.profileMutationGenerations.clear();
        reportSettingsSaveState('saved');
        set({
          selectedProfileId: null,
          defaultGitIdentityId: null,
          profiles: [],
          globalIdentity: null,
          isLoading: false,
        });
      },
    }),
    { name: 'git-identities-store' },
  ),
));

import React from 'react';
import { createStore } from 'zustand/vanilla';
import type { SourceControlAPI, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext } from '@/lib/api/types';
import { defineHostStore, defineHostValue, hostStoresLive } from '@/lib/hosts/runtime/host-bindings';
import { currentHostKey } from '@/lib/hosts/runtime/host-key';

export const getSourceControlAuthKey = (identity: SourceControlIdentity): string =>
  JSON.stringify([currentHostKey(), identity.provider, identity.instance]);

type SourceControlAuthEntry = {
  status: SourceControlAuthStatus | null;
  isLoading: boolean;
  hasChecked: boolean;
};

type SourceControlReadContextAuthState = {
  authChecked: boolean;
  connected: boolean;
};

export const getSourceControlReadContextAuthState = (
  entry: SourceControlAuthEntry | undefined,
  context: SourceControlReadContext,
): SourceControlReadContextAuthState => ({
  authChecked: entry?.hasChecked ?? false,
  connected: entry?.hasChecked === true
    && entry.status?.status !== 'unreachable'
    && entry.status?.status !== 'temporarily-unavailable'
    && entry.status?.accounts?.some((account) => account.id === context.accountId && account.status === 'valid') === true,
});

type SourceControlAuthStore = {
  identities: SourceControlIdentity[];
  identitiesLoaded: boolean;
  identitiesError: string | null;
  entries: Record<string, SourceControlAuthEntry>;
  refreshInstances: (sourceControl: Pick<SourceControlAPI, 'authInstances'>, options?: { force?: boolean }) => Promise<SourceControlIdentity[]>;
  refreshAll: (sourceControl: Pick<SourceControlAPI, 'authInstances' | 'authStatus'>, options?: { force?: boolean }) => Promise<void>;
  /**
   * Reads the accounts of the instances these identities name. An instance
   * whose last account was removed disappears from the configured list, so
   * `refreshAll` would never look at it again and an identity pointing into it
   * would look connected forever.
   */
  refreshIdentityAccounts: (
    sourceControl: Pick<SourceControlAPI, 'authStatus'>,
    identities: Array<SourceControlIdentity | null | undefined>,
  ) => Promise<void>;
  setStatus: (identity: SourceControlIdentity, status: SourceControlAuthStatus | null) => void;
  refreshStatus: (
    sourceControl: Pick<SourceControlAPI, 'authStatus'>,
    identity: SourceControlIdentity,
    options?: { force?: boolean },
  ) => Promise<SourceControlAuthStatus | null>;
  resetForRuntimeSwitch: () => void;
};

type AuthReads = {
  inFlight: Map<string, Promise<SourceControlAuthStatus | null>>;
  inFlightTokens: Map<string, symbol>;
  inFlightForced: Set<string>;
  // Bumped by every write that is newer than any read already on the wire: a
  // forced refresh (it follows an account mutation) or a direct status write.
  // A response whose read started under an older version describes the
  // instance before that write and is discarded.
  versions: Map<string, number>;
  instancesInFlight: Promise<SourceControlIdentity[]> | null;
  generation: number;
};

const authReads = defineHostValue<AuthReads>(() => ({
  inFlight: new Map(),
  inFlightTokens: new Map(),
  inFlightForced: new Set(),
  versions: new Map(),
  instancesInFlight: null,
  generation: 0,
}));

const bumpVersion = (versions: Map<string, number>, key: string): number => {
  const next = (versions.get(key) ?? 0) + 1;
  versions.set(key, next);
  return next;
};

const createEntry = (): SourceControlAuthEntry => ({ status: null, isLoading: false, hasChecked: false });

export const useSourceControlAuthStore = defineHostStore<SourceControlAuthStore>('source-control-auth', (host) => createStore<SourceControlAuthStore>()((set, get) => ({
  identities: [],
  identitiesLoaded: false,
  identitiesError: null,
  entries: {},
  refreshInstances: async (sourceControl, options) => {
    const current = get();
    const reads = host.run(authReads);
    if (reads.instancesInFlight) return reads.instancesInFlight;
    if (current.identitiesLoaded && !current.identitiesError && !options?.force) return current.identities;
    const requestGeneration = reads.generation;
    set({ identitiesError: null });
    const request = (async () => {
      try {
        const identities = await host.run(() => sourceControl.authInstances());
        if (requestGeneration !== reads.generation) return [];
        set({ identities, identitiesLoaded: true, identitiesError: null });
        return identities;
      } catch (error) {
        if (requestGeneration !== reads.generation) return [];
        const message = error instanceof Error ? error.message : String(error);
        set({ identitiesError: message });
        return get().identities;
      } finally {
        if (requestGeneration === reads.generation) reads.instancesInFlight = null;
      }
    })();
    reads.instancesInFlight = request;
    return request;
  },
  refreshAll: async (sourceControl, options) => {
    const reads = host.run(authReads);
    const requestGeneration = reads.generation;
    const identities = await get().refreshInstances(sourceControl, options);
    if (requestGeneration !== reads.generation || !hostStoresLive(host)) return;
    await Promise.all(identities.map((identity) => get().refreshStatus(sourceControl, identity, options)));
  },
  refreshIdentityAccounts: async (sourceControl, identities) => {
    const seen = new Set<string>();
    const targets: SourceControlIdentity[] = [];
    for (const entry of identities) {
      if (!entry) continue;
      const identity = { provider: entry.provider, instance: entry.instance };
      const key = getSourceControlAuthKey(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(identity);
    }
    await Promise.all(targets.map((identity) => get().refreshStatus(sourceControl, identity, { force: true })));
  },
  setStatus: (identity, status) => {
    const key = getSourceControlAuthKey(identity);
    const reads = host.run(authReads);
    bumpVersion(reads.versions, key);
    reads.inFlight.delete(key);
    reads.inFlightTokens.delete(key);
    reads.inFlightForced.delete(key);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), status, isLoading: false, hasChecked: true },
      },
    }));
  },
  refreshStatus: async (sourceControl, identity, options) => {
    const key = getSourceControlAuthKey(identity);
    const reads = host.run(authReads);
    const { inFlight, inFlightTokens, inFlightForced, versions } = reads;
    const current = get().entries[key];
    const pending = inFlight.get(key);
    // A forced refresh follows a mutation, so an ordinary read that started
    // before it cannot answer for it; forced reads issued together share one.
    if (pending && (!options?.force || inFlightForced.has(key))) return pending;
    if (!pending && current?.hasChecked && current.status?.status !== 'unreachable' && !options?.force) return current.status;

    const requestGeneration = reads.generation;
    const requestVersion = bumpVersion(versions, key);
    const requestToken = Symbol(key);
    const isCurrent = () => requestGeneration === reads.generation
      && versions.get(key) === requestVersion
      && hostStoresLive(host);
    // A superseded read hands its caller whatever replaced it.
    const superseded = () => inFlight.get(key) ?? (requestGeneration === reads.generation ? get().entries[key]?.status ?? null : null);
    const request = (async () => {
      try {
        const status = await host.run(() => sourceControl.authStatus(identity));
        if (!isCurrent()) return superseded();
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { status, isLoading: false, hasChecked: true },
          },
        }));
        return status;
      } catch (error) {
        if (!isCurrent()) return superseded();
        const message = error instanceof Error ? error.message : String(error);
        const status: SourceControlAuthStatus = {
          ...identity,
          status: 'unreachable',
          connected: false,
          // Retain credential metadata for account management, not read authority.
          accounts: get().entries[key]?.status?.accounts,
          cli: get().entries[key]?.status?.cli,
          message,
        };
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { status, isLoading: false, hasChecked: true },
          },
        }));
        return null;
      } finally {
        if (inFlightTokens.get(key) === requestToken) {
          inFlightTokens.delete(key);
          inFlight.delete(key);
          inFlightForced.delete(key);
        }
      }
    })();
    // Registered before subscribers hear about the load: one that asks for
    // this instance again from inside the notification joins this read
    // instead of starting another.
    inFlightTokens.set(key, requestToken);
    inFlight.set(key, request);
    if (options?.force) inFlightForced.add(key);
    else inFlightForced.delete(key);
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? createEntry()), isLoading: true },
      },
    }));
    return request;
  },
  resetForRuntimeSwitch: () => {
    const reads = host.run(authReads);
    reads.generation += 1;
    reads.inFlight.clear();
    reads.inFlightTokens.clear();
    reads.versions.clear();
    reads.inFlightForced.clear();
    reads.instancesInFlight = null;
    set({ identities: [], identitiesLoaded: false, identitiesError: null, entries: {} });
  },
})));

export const useSourceControlAuthEntry = (identity: SourceControlIdentity): SourceControlAuthEntry | undefined => {
  const key = getSourceControlAuthKey(identity);
  return useSourceControlAuthStore((state) => state.entries[key]);
};

/**
 * The credential IDs connected for a provider instance, or null when that
 * instance has not been read yet. Callers use it to tell an identity whose
 * account was disconnected from one whose accounts are simply not loaded.
 */
export const useConnectedAccountIds = (): ((identity: SourceControlIdentity) => string[] | null) => {
  const entries = useSourceControlAuthStore((state) => state.entries);
  return React.useCallback((identity: SourceControlIdentity) => {
    const accounts = entries[getSourceControlAuthKey(identity)]?.status?.accounts;
    return accounts ? accounts.map((account) => account.id) : null;
  }, [entries]);
};

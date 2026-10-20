// The chats of deleted isolated spaces, kept on the Archive page and read-only (decision 9 of the design,
// journey step 7). The host names each archive by the directory that holds its
// chats; this store answers, for a chat's directory, which deleted space it came from. It stays
// filled while the feature's switch is off, because those chats stay; each host has its own copy.
// The server refuses to run an archived chat whatever
// this store says; the store only lets the screen say so first.

import { createStore } from 'zustand/vanilla';

import { defineHostStore, defineHostValue, hostStoresLive, resolveHost } from '@/lib/hosts/runtime/host-bindings';
import { normalizePath } from '@/lib/pathNormalization';

import { listSpaceArchives, type SpaceArchive } from './spaces-api';

type SpaceArchivesState = {
  /**
   * By the directory that holds the chats, normalized as the session lists compare directories;
   * null until the host answered once for this runtime.
   */
  byDirectory: ReadonlyMap<string, SpaceArchive> | null;
  resetForRuntimeSwitch: () => void;
};

type ArchivesRead = { generation: number; reading: Promise<void> | null };

const archivesRead = defineHostValue<ArchivesRead>(() => ({ generation: 0, reading: null }));

export const useSpaceArchivesStore = defineHostStore<SpaceArchivesState>('space-archives', () => createStore<SpaceArchivesState>()((set) => {
  const read = archivesRead();
  return {
    byDirectory: null,
    resetForRuntimeSwitch: () => {
      read.generation += 1;
      read.reading = null;
      set({ byDirectory: null });
    },
  };
}));

/**
 * Reads the archives again. A read that fails leaves the last answer in place, so a chat known
 * to be archived never reads as live; one a runtime switch overtook is dropped.
 */
export const refreshSpaceArchives = (): Promise<void> => {
  const host = resolveHost();
  const book = archivesRead();
  if (book.reading) return book.reading;
  const started = book.generation;
  const read = listSpaceArchives()
    .then((archives) => {
      if (started !== book.generation || !hostStoresLive(host)) return;
      const byDirectory = new Map<string, SpaceArchive>();
      for (const archive of archives) {
        const directory = normalizePath(archive.directory);
        if (directory) byDirectory.set(directory, archive);
      }
      host.run(() => useSpaceArchivesStore.setState({ byDirectory }));
    })
    .finally(() => {
      if (book.reading === read) book.reading = null;
    });
  book.reading = read;
  return read;
};

/** Reads the archives once for this runtime, when nothing has been read yet; a failure is left for the next call. */
export const ensureSpaceArchives = (): void => {
  if (useSpaceArchivesStore.getState().byDirectory !== null) return;
  void refreshSpaceArchives().catch(() => {});
};

/** Whether a directory holds the archived chats of a deleted space, as this runtime last read the archives. */
export const isSpaceArchiveDirectory = (directory: string | null | undefined): boolean => {
  const key = normalizePath(directory);
  return key !== null && (useSpaceArchivesStore.getState().byDirectory?.has(key) ?? false);
};

/** The deleted space whose chats a directory holds, or null. */
export const useSpaceArchiveOf = (directory: string | null | undefined): SpaceArchive | null => {
  const key = normalizePath(directory);
  return useSpaceArchivesStore((state) => (key ? state.byDirectory?.get(key) ?? null : null));
};

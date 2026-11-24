import { z } from 'zod';

export type HostAppearanceKind = 'labels' | 'logos';
export type HostAppearanceStamp = { at: number; removed?: true };
export type HostAppearanceStamps = Record<string, HostAppearanceStamp>;
export type HostAppearance = {
  hostLabels: Record<string, string>;
  hostLogos: Record<string, string>;
  hostAppearanceStamps: HostAppearanceStamps;
};

const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_PINNED_ORDER = 256;
const KINDS: readonly HostAppearanceKind[] = ['labels', 'logos'];

export const SEEDED_STAMP_AT = 1;

const stampKeyOf = (kind: HostAppearanceKind, hostKey: string): string => `${kind}:${hostKey}`;
const valuesOf = (side: HostAppearance, kind: HostAppearanceKind): Record<string, string> => (
  kind === 'labels' ? side.hostLabels : side.hostLogos
);

type Entry = { at: number; value: string | null };

const entryOf = (value: string | undefined, stamp: HostAppearanceStamp | undefined, now: number): Entry | null => {
  if (stamp) {
    const at = Math.min(stamp.at, now + MAX_CLOCK_LEAD_MS);
    return { at, value: value !== undefined && !stamp.removed ? value : null };
  }
  return value !== undefined ? { at: 0, value } : null;
};

const winnerOf = (left: Entry | null, right: Entry | null): Entry | null => {
  if (!left || !right) return left ?? right;
  if (left.at !== right.at) return left.at > right.at ? left : right;
  if (left.value === null || right.value === null) return left.value === null ? right : left;
  return left.value >= right.value ? left : right;
};

export const mergeHostAppearance = (left: HostAppearance, right: HostAppearance, now: number): HostAppearance => {
  const merged: HostAppearance = { hostLabels: {}, hostLogos: {}, hostAppearanceStamps: {} };
  const stampKeys = new Set([...Object.keys(left.hostAppearanceStamps), ...Object.keys(right.hostAppearanceStamps)]);
  for (const kind of KINDS) {
    for (const hostKey of [...Object.keys(valuesOf(left, kind)), ...Object.keys(valuesOf(right, kind))]) {
      stampKeys.add(stampKeyOf(kind, hostKey));
    }
  }
  for (const stampKey of stampKeys) {
    const separator = stampKey.indexOf(':');
    const kind = stampKey.slice(0, separator);
    const hostKey = stampKey.slice(separator + 1);
    if ((kind !== 'labels' && kind !== 'logos') || !hostKey) continue;
    const entry = winnerOf(
      entryOf(valuesOf(left, kind)[hostKey], left.hostAppearanceStamps[stampKey], now),
      entryOf(valuesOf(right, kind)[hostKey], right.hostAppearanceStamps[stampKey], now),
    );
    if (!entry) continue;
    if (entry.value === null && entry.at < now - TOMBSTONE_TTL_MS) continue;
    if (entry.value !== null) valuesOf(merged, kind)[hostKey] = entry.value;
    if (entry.at > 0 || entry.value === null) {
      merged.hostAppearanceStamps[stampKey] = entry.value === null ? { at: entry.at, removed: true } : { at: entry.at };
    }
  }
  return merged;
};

export const nextHostAppearanceStamp = (
  stamps: HostAppearanceStamps,
  kind: HostAppearanceKind,
  hostKey: string,
  removed: boolean,
  now: number,
) => {
  const stampKey = stampKeyOf(kind, hostKey);
  const at = Math.max(now, (stamps[stampKey]?.at ?? 0) + 1);
  const stamp: HostAppearanceStamp = removed ? { at, removed: true } : { at };
  return { ...stamps, [stampKey]: stamp };
};

export const hasHostAppearanceStamp = (stamps: HostAppearanceStamps, kind: HostAppearanceKind, hostKey: string): boolean => (
  stampKeyOf(kind, hostKey) in stamps
);

export const mergePinnedOrder = (newer: readonly string[], older: readonly string[]): string[] => (
  [...new Set([...newer, ...older])].slice(0, MAX_PINNED_ORDER)
);

export type HostAppearanceWriteOptions = { seed?: boolean };

export const stampHostAppearance = (
  stamps: HostAppearanceStamps,
  kind: HostAppearanceKind,
  hostKey: string,
  removed: boolean,
  options?: HostAppearanceWriteOptions,
): HostAppearanceStamps => (
  options?.seed && !removed
    ? { ...stamps, [stampKeyOf(kind, hostKey)]: { at: SEEDED_STAMP_AT } }
    : nextHostAppearanceStamp(stamps, kind, hostKey, removed, Date.now())
);

const HOST_APPEARANCE_STAMPS_MAX = 256;
const HOST_APPEARANCE_STAMP_KEY_MAX = 140;
const stampSchema = z.object({ at: z.number().finite().min(0), removed: z.literal(true).optional() });

export const hostAppearanceStampsSchema = z.record(z.string(), z.unknown()).transform((record) => {
  const result: HostAppearanceStamps = {};
  for (const [key, entry] of Object.entries(record).slice(0, HOST_APPEARANCE_STAMPS_MAX)) {
    const stamp = stampSchema.safeParse(entry);
    if (key.length > HOST_APPEARANCE_STAMP_KEY_MAX || !stamp.success) continue;
    result[key] = stamp.data.removed ? { at: stamp.data.at, removed: true } : { at: stamp.data.at };
  }
  return result;
});

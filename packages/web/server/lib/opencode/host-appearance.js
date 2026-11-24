// Per-key merge of the shared host names and icons; the UI keeps an identical
// copy in `packages/ui/src/lib/settings/host-appearance.ts` (same test vectors).
const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_PINNED_ORDER = 256;

export const SHARED_SIDEBAR_KEYS = Object.freeze([
  'hostLabels',
  'hostLogos',
  'hostAppearanceStamps',
  'sidebarPinnedOrder',
  'sidebarHostOrder',
  'sidebarSessionSortOrder',
  'sidebarShowPinnedSection',
]);

const valuesOf = (side, kind) => (kind === 'labels' ? side.hostLabels : side.hostLogos);

const entryOf = (value, stamp, now) => {
  if (stamp) {
    const at = Math.min(stamp.at, now + MAX_CLOCK_LEAD_MS);
    return { at, value: value !== undefined && !stamp.removed ? value : null };
  }
  return value !== undefined ? { at: 0, value } : null;
};

const winnerOf = (left, right) => {
  if (!left || !right) return left ?? right;
  if (left.at !== right.at) return left.at > right.at ? left : right;
  if (left.value === null || right.value === null) return left.value === null ? right : left;
  return left.value >= right.value ? left : right;
};

export const hostAppearanceOf = (settings) => ({
  hostLabels: settings.hostLabels ?? {},
  hostLogos: settings.hostLogos ?? {},
  hostAppearanceStamps: settings.hostAppearanceStamps ?? {},
});

export const mergeHostAppearance = (left, right, now) => {
  const merged = { hostLabels: {}, hostLogos: {}, hostAppearanceStamps: {} };
  const stampKeys = new Set([...Object.keys(left.hostAppearanceStamps), ...Object.keys(right.hostAppearanceStamps)]);
  for (const kind of ['labels', 'logos']) {
    for (const hostKey of [...Object.keys(valuesOf(left, kind)), ...Object.keys(valuesOf(right, kind))]) {
      stampKeys.add(`${kind}:${hostKey}`);
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

export const mergePinnedOrder = (newer, older) => [...new Set([...newer, ...older])].slice(0, MAX_PINNED_ORDER);

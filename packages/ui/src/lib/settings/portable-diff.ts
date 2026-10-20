import { PORTABLE_CATEGORIES, type PortableCategory, type PortableItem, type PortableSnapshot } from './portable-settings';

type PortableHostSnapshot = { hostId: string; snapshot: PortableSnapshot | null };

export type PortableHostState =
  | { kind: 'unreachable' }
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'present'; version: number; updatedAt: number | null; newest: boolean };

export type PortableDiffRow = {
  category: PortableCategory;
  key: string;
  label: string;
  detail: string | null;
  paths: readonly string[];
  states: ReadonlyMap<string, PortableHostState>;
};

type Found = { hostId: string; item: PortableItem };

const itemsOf = (snapshot: PortableSnapshot | null, category: PortableCategory): Map<string, PortableItem> | null => {
  const entry = snapshot?.[category];
  return entry?.status === 'ok' ? new Map(entry.items.map((item) => [item.key, item])) : null;
};

const newestHostOf = (found: readonly Found[], versions: number): string | null => {
  if (versions < 2) return null;
  const dated = found.filter(({ item }) => item.updatedAt !== null);
  if (dated.length < 2) return null;
  return dated.reduce((latest, entry) => ((entry.item.updatedAt ?? 0) > (latest.item.updatedAt ?? 0) ? entry : latest)).hostId;
};

const rowFor = (category: PortableCategory, key: string, hosts: readonly PortableHostSnapshot[], lists: ReadonlyMap<string, Map<string, PortableItem> | null>): PortableDiffRow | null => {
  const found: Found[] = [];
  const versionOf = new Map<string, number>();
  let missing = 0;
  for (const { hostId } of hosts) {
    const list = lists.get(hostId);
    if (!list) continue;
    const item = list.get(key);
    if (!item) {
      missing += 1;
      continue;
    }
    found.push({ hostId, item });
    if (!versionOf.has(item.fingerprint)) versionOf.set(item.fingerprint, versionOf.size + 1);
  }
  if (missing === 0 && versionOf.size <= 1) return null;
  const newestHost = newestHostOf(found, versionOf.size);
  const states = new Map<string, PortableHostState>();
  for (const { hostId, snapshot } of hosts) {
    if (!snapshot) states.set(hostId, { kind: 'unreachable' });
    else if (!lists.get(hostId)) states.set(hostId, { kind: 'unknown' });
    else states.set(hostId, { kind: 'missing' });
  }
  for (const { hostId, item } of found) {
    states.set(hostId, { kind: 'present', version: versionOf.get(item.fingerprint) ?? 1, updatedAt: item.updatedAt, newest: hostId === newestHost });
  }
  const sample = found[0].item;
  return { category, key, label: sample.label, detail: sample.detail ?? null, paths: sample.paths, states };
};

export const computePortableDiff = (hosts: readonly PortableHostSnapshot[]): PortableDiffRow[] => PORTABLE_CATEGORIES.flatMap((category) => {
  const lists = new Map(hosts.map(({ hostId, snapshot }) => [hostId, itemsOf(snapshot, category)]));
  const keys = new Set<string>();
  for (const list of lists.values()) for (const key of list?.keys() ?? []) keys.add(key);
  return [...keys]
    .flatMap((key) => rowFor(category, key, hosts, lists) ?? [])
    .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
});

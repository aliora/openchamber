import { hostOrderKeys } from '@/lib/hosts/host-order';

// The Pinned zone's saved order names a session by its host's order key and
// its id: saved host ids differ per client, and two hosts may hold sessions
// with the same id.

/** Every key a pinned session can be saved under, the primary one first. */
export const pinnedOrderKeys = (host: Parameters<typeof hostOrderKeys>[0], sessionId: string): string[] => (
  hostOrderKeys(host).map((key) => `${key}#${sessionId}`)
);

const positionIn = (order: readonly string[], keys: readonly string[]): number => {
  const positions = keys.map((key) => order.indexOf(key)).filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : Number.POSITIVE_INFINITY;
};

/** Saved entries first, in their saved order; the rest keep the order they came in. */
export const sortByPinnedOrder = <T>(items: readonly T[], keysOf: (item: T) => readonly string[], order: readonly string[]): T[] => items
  .map((item, index) => ({ item, index, position: positionIn(order, keysOf(item)) }))
  .sort((left, right) => left.position - right.position || left.index - right.index)
  .map((entry) => entry.item);

/**
 * Moves one shown entry onto another's place. The result saves every shown
 * entry by its primary key and keeps the entries this client does not show.
 */
export const movePinnedInOrder = (
  order: readonly string[],
  shown: readonly (readonly string[])[],
  fromKey: string,
  toKey: string,
): string[] => {
  const primaries = shown.map((keys) => keys[0]);
  const from = primaries.indexOf(fromKey);
  const to = primaries.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return [...order];
  const moved = [...primaries];
  const [entry] = moved.splice(from, 1);
  moved.splice(to, 0, entry);
  const shownKeys = new Set(shown.flat());
  return [...moved, ...order.filter((key) => !shownKeys.has(key))];
};

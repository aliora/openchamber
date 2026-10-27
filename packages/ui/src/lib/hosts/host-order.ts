import type { HostDescriptor } from './types';

export type HostIdentity = {
  descriptor: HostDescriptor;
  serverId: string | null;
};

const normalizeLabel = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, ' ');

export const hostOrderKeys = ({ descriptor, serverId }: { descriptor: Pick<HostDescriptor, 'label'>; serverId: string | null }): string[] => {
  const labelKey = `label:${normalizeLabel(descriptor.label)}`;
  return serverId ? [`server:${serverId}`, labelKey] : [labelKey];
};

export const primaryHostOrderKey = (host: HostIdentity): string => hostOrderKeys(host)[0];

const positionIn = (order: readonly string[], keys: readonly string[]): number => {
  const positions = keys.map((key) => order.indexOf(key)).filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : Number.POSITIVE_INFINITY;
};

export const sortByHostOrder = <T>(
  items: readonly T[],
  identityOf: (item: T) => HostIdentity,
  order: readonly string[],
): T[] => items
  .map((item) => {
    const identity = identityOf(item);
    return { item, position: positionIn(order, hostOrderKeys(identity)), label: normalizeLabel(identity.descriptor.label), id: identity.descriptor.id };
  })
  .sort((left, right) => (
    left.position - right.position || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  ))
  .map((entry) => entry.item);

export const moveHostInOrder = (
  order: readonly string[],
  shown: readonly HostIdentity[],
  fromKey: string,
  toKey: string,
): string[] => {
  const keys = shown.map(primaryHostOrderKey);
  const from = keys.indexOf(fromKey);
  const to = keys.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return [...order];
  const moved = [...keys];
  const [entry] = moved.splice(from, 1);
  moved.splice(to, 0, entry);
  const shownKeys = new Set(shown.flatMap(hostOrderKeys));
  return [...moved, ...order.filter((key) => !shownKeys.has(key))];
};

import {
  exportPortableItems,
  importPortableItems,
  type PortableExport,
  type PortableImportItem,
  type PortableImportResult,
  type PortableRef,
  type PortableRemoval,
  type PortableRequest,
} from './portable-settings';

export type PortableEndpoint = { id: string; request: PortableRequest };

export type PortableTargetOutcome =
  | { hostId: string; status: 'done'; results: PortableImportResult[] }
  | { hostId: string; status: 'unreachable' };

type PortableCopyOutcome =
  | { status: 'source-unreachable' }
  | { status: 'done'; notExported: Exclude<PortableExport, { status: 'found' }>[]; targets: PortableTargetOutcome[] };

export const sendPortableChanges = async (
  target: PortableEndpoint,
  changes: { items: readonly PortableImportItem[]; removals: readonly PortableRemoval[]; force: boolean },
): Promise<PortableTargetOutcome> => {
  try {
    return { hostId: target.id, status: 'done', results: await importPortableItems(target.request, changes) };
  } catch {
    return { hostId: target.id, status: 'unreachable' };
  }
};

export const toImportItem = (entry: Extract<PortableExport, { status: 'found' }>): PortableImportItem => ({
  category: entry.category,
  key: entry.key,
  value: entry.value,
  updatedAt: entry.updatedAt,
});

export const copyPortableItems = async (
  source: PortableEndpoint,
  targets: readonly PortableEndpoint[],
  refs: readonly PortableRef[],
  force: boolean,
): Promise<PortableCopyOutcome> => {
  if (refs.length === 0 || targets.length === 0) return { status: 'done', notExported: [], targets: [] };
  let exported: PortableExport[];
  try {
    exported = await exportPortableItems(source.request, refs);
  } catch {
    return { status: 'source-unreachable' };
  }
  const items = exported.flatMap((entry) => (entry.status === 'found' ? [toImportItem(entry)] : []));
  const notExported = exported.flatMap((entry) => (entry.status === 'found' ? [] : [entry]));
  if (items.length === 0) return { status: 'done', notExported, targets: [] };
  const outcomes = await Promise.all(targets.map((target) => sendPortableChanges(target, { items, removals: [], force })));
  return { status: 'done', notExported, targets: outcomes };
};

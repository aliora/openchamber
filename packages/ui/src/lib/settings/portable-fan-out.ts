import { sendPortableChanges, toImportItem, type PortableEndpoint, type PortableTargetOutcome } from './portable-apply';
import { exportPortableItems, type PortableCategory, type PortableExport, type PortableImportResult, type PortableRef, type PortableRemoval } from './portable-settings';

export type PortableFanOutHost = PortableEndpoint & { label: string; reachable: boolean };

type PortableFanOutProblem = {
  hostId: string;
  label: string;
  reason: 'offline' | 'unreachable' | 'failed' | 'source-unreachable';
};

type PortableFanOutRefusal = { hostId: string; label: string; result: PortableImportResult };

export type PortableFanOutReport = { problems: PortableFanOutProblem[]; refusals: PortableFanOutRefusal[] };

type PortableFanOutDependencies = {
  listHosts(): readonly PortableFanOutHost[];
  setTimer(callback: () => void, ms: number): () => void;
  debounceMs: number;
  now(): number;
  report(report: PortableFanOutReport): void;
};

type PortableFanOut = {
  changed(category: PortableCategory, key: string, sourceId: string): void;
  removed(category: PortableCategory, key: string, sourceId: string): void;
  flush(): Promise<void>;
  cancel(): void;
};

type PendingChange = { sourceId: string; ref: PortableRef; kind: 'changed' | 'removed'; at: number };

const pendingKey = (change: PendingChange): string => [change.sourceId, change.ref.category, change.ref.key].join('\u0000');

const groupBySource = (changes: readonly PendingChange[]): Map<string, PendingChange[]> => {
  const groups = new Map<string, PendingChange[]>();
  for (const change of changes) groups.set(change.sourceId, [...(groups.get(change.sourceId) ?? []), change]);
  return groups;
};

const collect = (outcomes: readonly PortableTargetOutcome[], hosts: readonly PortableFanOutHost[], report: PortableFanOutReport): void => {
  for (const outcome of outcomes) {
    const label = hosts.find((host) => host.id === outcome.hostId)?.label ?? outcome.hostId;
    if (outcome.status === 'unreachable') {
      report.problems.push({ hostId: outcome.hostId, label, reason: 'unreachable' });
      continue;
    }
    if (outcome.results.some((result) => result.status === 'failed')) report.problems.push({ hostId: outcome.hostId, label, reason: 'failed' });
    for (const result of outcome.results) {
      if (result.status === 'refused') report.refusals.push({ hostId: outcome.hostId, label, result });
    }
  }
};

const dedupeProblems = (problems: readonly PortableFanOutProblem[]): PortableFanOutProblem[] => {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.hostId}\u0000${problem.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const createPortableFanOut = (dependencies: PortableFanOutDependencies): PortableFanOut => {
  const pending = new Map<string, PendingChange>();
  let cancelTimer: (() => void) | null = null;

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const sendFrom = async (sourceId: string, changes: readonly PendingChange[], hosts: readonly PortableFanOutHost[], report: PortableFanOutReport): Promise<void> => {
    const source = hosts.find((host) => host.id === sourceId);
    const others = hosts.filter((host) => host.id !== sourceId);
    if (!source || others.length === 0) return;
    for (const host of others) {
      if (!host.reachable) report.problems.push({ hostId: host.id, label: host.label, reason: 'offline' });
    }
    const targets = others.filter((host) => host.reachable);
    if (targets.length === 0) return;
    let exported: PortableExport[];
    try {
      exported = await exportPortableItems(source.request, changes.map((change) => change.ref));
    } catch {
      report.problems.push({ hostId: source.id, label: source.label, reason: 'source-unreachable' });
      return;
    }
    const items = exported.flatMap((entry) => (entry.status === 'found' ? [toImportItem(entry)] : []));
    const removals: PortableRemoval[] = changes.flatMap((change, index) => {
      const entry = exported[index];
      return change.kind === 'removed' && entry?.status === 'missing' ? [{ category: entry.category, key: entry.key, updatedAt: change.at }] : [];
    });
    if (items.length === 0 && removals.length === 0) return;
    collect(await Promise.all(targets.map((target) => sendPortableChanges(target, { items, removals, force: false }))), hosts, report);
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    const changes = [...pending.values()];
    pending.clear();
    if (changes.length === 0) return;
    const hosts = dependencies.listHosts();
    const report: PortableFanOutReport = { problems: [], refusals: [] };
    await Promise.all([...groupBySource(changes)].map(([sourceId, group]) => sendFrom(sourceId, group, hosts, report)));
    dependencies.report({ problems: dedupeProblems(report.problems), refusals: report.refusals });
  };

  const queue = (kind: PendingChange['kind'], category: PortableCategory, key: string, sourceId: string): void => {
    const change: PendingChange = { sourceId, ref: { category, key }, kind, at: dependencies.now() };
    pending.set(pendingKey(change), change);
    clearTimer();
    cancelTimer = dependencies.setTimer(() => void flush(), dependencies.debounceMs);
  };

  return {
    changed: (category, key, sourceId) => queue('changed', category, key, sourceId),
    removed: (category, key, sourceId) => queue('removed', category, key, sourceId),
    flush,
    cancel() {
      clearTimer();
      pending.clear();
    },
  };
};

import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useHostOptions, type HostOption } from '@/components/sections/shared/useHostOptions';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { copyPortableItems } from '@/lib/settings/portable-apply';
import { computePortableDiff, type PortableDiffRow } from '@/lib/settings/portable-diff';
import { fetchPortableSnapshot, PORTABLE_CATEGORIES, type PortableRef, type PortableSnapshot } from '@/lib/settings/portable-settings';
import { usePortableFanOutReportStore } from '@/lib/settings/portable-sync';
import { CATEGORY_TITLE, outcomeLabel, stateLabel, type SyncLabel, type SyncOutcome } from './syncLabels';

type HostOutcome = { hostId: string; outcome: SyncOutcome };

const rowKeyOf = (ref: PortableRef): string => `${ref.category}\u0000${ref.key}`;

const hostsKeyOf = (hosts: readonly HostOption[]): string => hosts.map((host) => `${host.id}:${host.reachable}`).join('|');

const Pill: React.FC<{ label: SyncLabel }> = ({ label }) => {
  const { t } = useI18n();
  return <SettingsCardPill tone={label.tone}>{t(label.key, label.params)}</SettingsCardPill>;
};

const collectOutcomes = (refs: readonly PortableRef[], result: Awaited<ReturnType<typeof copyPortableItems>>, sourceId: string): Map<string, HostOutcome[]> => {
  const byRow = new Map<string, HostOutcome[]>();
  const add = (ref: PortableRef, entry: HostOutcome) => byRow.set(rowKeyOf(ref), [...(byRow.get(rowKeyOf(ref)) ?? []), entry]);
  if (result.status !== 'done') return byRow;
  for (const entry of result.notExported) {
    add(entry, { hostId: sourceId, outcome: { kind: 'not-exported', reason: entry.status === 'missing' ? 'missing' : entry.reason } });
  }
  for (const target of result.targets) {
    if (target.status === 'unreachable') {
      for (const ref of refs) add(ref, { hostId: target.hostId, outcome: { kind: 'unreachable' } });
      continue;
    }
    for (const entry of target.results) add(entry, { hostId: target.hostId, outcome: { kind: 'result', result: entry } });
  }
  return byRow;
};

type SyncRowProps = {
  row: PortableDiffRow;
  hosts: readonly HostOption[];
  selectable: boolean;
  selected: boolean;
  outcomes: readonly HostOutcome[];
  onToggle: (selected: boolean) => void;
};

const SyncRow: React.FC<SyncRowProps> = ({ row, hosts, selectable, selected, outcomes, onToggle }) => {
  const { t } = useI18n();
  const labelOf = (hostId: string) => hosts.find((host) => host.id === hostId)?.label ?? hostId;
  return (
    <div className="flex items-start gap-2 py-1.5" data-sync-row={row.category}>
      <Checkbox
        checked={selected}
        onChange={onToggle}
        disabled={!selectable}
        ariaLabel={t('settings.sync.selectItem', { item: row.label })}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="typography-ui-label min-w-0 truncate">{row.label}</span>
          {row.detail ? <span className="typography-meta min-w-0 truncate text-muted-foreground">{row.detail}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {hosts.map((host) => {
            const state = row.states.get(host.id);
            if (!state) return null;
            return (
              <span key={host.id} className="inline-flex min-w-0 items-center gap-1">
                <span className="typography-micro max-w-[10rem] truncate text-muted-foreground">{host.label}</span>
                <Pill label={stateLabel(state)} />
              </span>
            );
          })}
        </div>
        {!selectable ? <span className={SETTINGS_HELPER_CLASS}>{t('settings.sync.notOnSource')}</span> : null}
        {outcomes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {outcomes.map(({ hostId, outcome }, index) => (
              <span key={`${hostId}-${index}`} className="inline-flex min-w-0 items-center gap-1">
                <span className="typography-micro max-w-[10rem] truncate text-muted-foreground">{labelOf(hostId)}</span>
                <Pill label={outcomeLabel(outcome)} />
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const SyncPageView: React.FC<{ hosts: readonly HostOption[] }> = ({ hosts }) => {
  const { t } = useI18n();
  const hostsRef = React.useRef(hosts);
  hostsRef.current = hosts;
  const hostsKey = hostsKeyOf(hosts);
  const [snapshots, setSnapshots] = React.useState<ReadonlyMap<string, PortableSnapshot | null>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [pickedSourceId, setPickedSourceId] = React.useState<string | null>(null);
  const [excludedTargets, setExcludedTargets] = React.useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = React.useState<ReadonlyMap<string, HostOutcome[]>>(new Map());
  const [applying, setApplying] = React.useState(false);
  const lastReport = usePortableFanOutReportStore((state) => state.lastReport);
  const loadGeneration = React.useRef(0);

  const load = React.useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const entries = await Promise.all(hostsRef.current.map(async (host): Promise<[string, PortableSnapshot | null]> => (
      [host.id, host.reachable ? await fetchPortableSnapshot(host.request).catch(() => null) : null]
    )));
    if (generation !== loadGeneration.current) return;
    setSnapshots(new Map(entries));
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [hostsKey, load]);

  const loadedHosts = hosts.filter((host) => snapshots.get(host.id));
  const sourceId = loadedHosts.some((host) => host.id === pickedSourceId) ? pickedSourceId : loadedHosts[0]?.id ?? null;
  const source = loadedHosts.find((host) => host.id === sourceId) ?? null;
  const targets = loadedHosts.filter((host) => host.id !== sourceId && !excludedTargets.has(host.id));
  const rows = React.useMemo(
    () => computePortableDiff(hosts.map((host) => ({ hostId: host.id, snapshot: snapshots.get(host.id) ?? null }))),
    [hosts, snapshots],
  );
  const sourceHas = (row: PortableDiffRow) => sourceId !== null && row.states.get(sourceId)?.kind === 'present';
  const selectableRows = rows.filter(sourceHas);
  const chosen = selectableRows.filter((row) => selected.has(rowKeyOf(row)));
  const failedHosts = [...new Set(lastReport?.problems.map((problem) => problem.label) ?? [])];

  const toggleRow = (row: PortableDiffRow, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(rowKeyOf(row));
    else next.delete(rowKeyOf(row));
    return next;
  });

  const toggleTarget = (hostId: string, checked: boolean) => setExcludedTargets((current) => {
    const next = new Set(current);
    if (checked) next.delete(hostId);
    else next.add(hostId);
    return next;
  });

  const apply = async () => {
    if (!source || targets.length === 0 || chosen.length === 0) return;
    setApplying(true);
    const refs = chosen.map(({ category, key }) => ({ category, key }));
    try {
      const result = await copyPortableItems(source, targets, refs, true);
      if (result.status === 'source-unreachable') {
        toast.error(t('settings.sync.sourceUnreachable'));
        return;
      }
      setOutcomes(collectOutcomes(refs, result, source.id));
      setSelected(new Set());
      const applied = result.targets.reduce((count, target) => count + (target.status === 'done' ? target.results.filter((entry) => entry.status === 'applied').length : 0), 0);
      if (applied === 1) toast.success(t('settings.sync.appliedToastOne'));
      else if (applied > 1) toast.success(t('settings.sync.appliedToastMany', { count: applied }));
      await load();
    } finally {
      setApplying(false);
    }
  };

  const reachableCount = hosts.filter((host) => host.reachable).length;

  return (
    <SettingsPageLayout
      title={t('settings.page.sync.title')}
      description={t('settings.page.sync.description')}
      headerEnd={<Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>{t('settings.sync.refresh')}</Button>}
      showSaveStatus={false}
    >
      <SettingsSection title={t('settings.sync.section.direction')} divider={false} contentClassName="space-y-3">
        <SettingsFieldRow label={t('settings.sync.source.label')} settingsItem="sync.source">
          <Select value={sourceId ?? ''} onValueChange={(value) => setPickedSourceId(value)} disabled={loadedHosts.length === 0}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.sync.source.label')}>
              <SelectValue>{(value) => loadedHosts.find((host) => host.id === value)?.label ?? ''}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {loadedHosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsControlGroup title={t('settings.sync.targets.label')} settingsItem="sync.targets">
          {hosts.filter((host) => host.id !== sourceId).map((host) => {
            const loaded = Boolean(snapshots.get(host.id));
            return (
              <SettingsCheckboxRow
                key={host.id}
                checked={loaded && !excludedTargets.has(host.id)}
                onChange={(checked) => toggleTarget(host.id, checked)}
                disabled={!loaded}
                label={host.label}
                description={!loaded && !loading ? t('settings.sync.host.offline') : undefined}
              />
            );
          })}
        </SettingsControlGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.sync.section.differences')} info={t('settings.sync.section.differencesInfo')} contentClassName="space-y-3">
        {failedHosts.length > 0 ? <p className="typography-meta text-[var(--status-warning)]">{t('settings.sync.lastFanOut', { hosts: failedHosts.join(', ') })}</p> : null}
        {loading && snapshots.size === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sync.loading')}</p> : null}
        {!loading && reachableCount < 2 ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sync.empty.singleHost')}</p> : null}
        {!loading && reachableCount >= 2 && rows.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sync.empty.same')}</p> : null}
        {selectableRows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SettingsCheckboxRow
              checked={chosen.length === selectableRows.length}
              onChange={(checked) => setSelected(checked ? new Set(selectableRows.map(rowKeyOf)) : new Set())}
              label={t('settings.sync.selectAll')}
            />
            <Button size="sm" disabled={applying || chosen.length === 0 || targets.length === 0} onClick={() => void apply()}>
              {applying ? t('settings.sync.applying') : chosen.length === 1 ? t('settings.sync.applyOne') : t('settings.sync.applyMany', { count: chosen.length })}
            </Button>
          </div>
        ) : null}
        {chosen.length > 0 && targets.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sync.noTargets')}</p> : null}
        {PORTABLE_CATEGORIES.map((category) => {
          const categoryRows = rows.filter((row) => row.category === category);
          if (categoryRows.length === 0) return null;
          return (
            <SettingsControlGroup key={category} title={t(CATEGORY_TITLE[category])}>
              {categoryRows.map((row) => (
                <SyncRow
                  key={rowKeyOf(row)}
                  row={row}
                  hosts={hosts}
                  selectable={sourceHas(row)}
                  selected={selected.has(rowKeyOf(row))}
                  outcomes={outcomes.get(rowKeyOf(row)) ?? []}
                  onToggle={(checked) => toggleRow(row, checked)}
                />
              ))}
            </SettingsControlGroup>
          );
        })}
      </SettingsSection>
    </SettingsPageLayout>
  );
};

export const SyncPage: React.FC = () => <SyncPageView hosts={useHostOptions()} />;

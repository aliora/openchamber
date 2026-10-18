import React from 'react';
import { ClassificationProvidersPage } from '@/components/sections/classification/ClassificationProvidersPage';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import type { EngineId } from '@/components/setup-wizard/engineSetupModel';
import { useEngineSetupPolling, useEngineSetupStore } from '@/components/setup-wizard/useEngineSetupStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n } from '@/lib/i18n';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { EngineDetail } from './EngineDetail';
import { EnginesGrid } from './EnginesGrid';

type PageView = { kind: 'grid' } | { kind: 'classification' } | { kind: 'engine'; engine: EngineId } | { kind: 'provider'; providerId: string };

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const classificationRequested = useUIStore((state) => state.settingsProvidersClassificationRequested);
  const setClassificationRequested = useUIStore((state) => state.setSettingsProvidersClassificationRequested);
  const openRequested = useUIStore((state) => state.settingsProvidersOpenRequested);
  const setOpenRequested = useUIStore((state) => state.setSettingsProvidersOpenRequested);
  const snapshots = useEngineSetupStore((state) => state.snapshots);
  const error = useEngineSetupStore((state) => state.error);
  const refresh = useEngineSetupStore((state) => state.refresh);
  const enterpriseMode = useEnterpriseMode();
  const [view, setView] = React.useState<PageView>(() => (
    classificationRequested ? { kind: 'classification' } : openRequested ? { kind: 'provider', providerId: openRequested } : { kind: 'grid' }
  ));
  useEngineSetupPolling(true);

  React.useEffect(() => {
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [loadProviders, settingsDirectory]);

  React.useEffect(() => {
    if (!classificationRequested) return;
    setView({ kind: 'classification' });
    setClassificationRequested(false);
  }, [classificationRequested, setClassificationRequested]);

  React.useEffect(() => {
    if (!openRequested) return;
    setView({ kind: 'provider', providerId: openRequested });
    setOpenRequested(null);
  }, [openRequested, setOpenRequested]);

  const all = [...snapshots.values()];
  const modelCounts = new Map(providers.map((provider) => [provider.id, provider.models.length]));
  const backToGrid = () => setView({ kind: 'grid' });

  if (view.kind === 'classification') {
    return (
      <ClassificationProvidersPage
        titleLeading={<SettingsBackButton label={t('engines.page.back')} onClick={backToGrid} />}
        onOpenProvider={(providerId) => setView({ kind: 'provider', providerId })}
      />
    );
  }

  const selected = view.kind === 'engine'
    ? snapshots.get(view.engine)
    : view.kind === 'provider' ? all.find((snapshot) => snapshot.status.providerID === view.providerId) : undefined;

  if (selected) {
    return (
      <EngineDetail
        snapshot={selected}
        provider={providers.find((provider) => provider.id === selected.status.providerID)}
        enterpriseMode={enterpriseMode}
        onBack={backToGrid}
      />
    );
  }

  return (
    <EnginesGrid
      snapshots={all}
      modelCounts={modelCounts}
      error={error}
      onSelect={(snapshot) => setView({ kind: 'engine', engine: snapshot.status.engine })}
      onRefresh={() => void refresh()}
    />
  );
};

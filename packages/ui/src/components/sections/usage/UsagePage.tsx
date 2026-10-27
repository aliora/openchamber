import React from 'react';
import { UsageCard } from './UsageCard';
import { CliSignInHint } from './CliSignInHint';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { UsageWindow } from '@/types';
import { useI18n } from '@/lib/i18n';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
} from '@/components/sections/shared/SettingsSection';

const formatTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

interface ModelInfo {
  name: string;
  /** The first window the model reports: the one its row shows. */
  label: string;
  window: UsageWindow;
}

export const UsagePage: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const loadSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const blink = useWaitingBlink(isLoading);
  const lastUpdated = useQuotaStore((state) => state.lastUpdated);
  const refreshErrors = useQuotaStore((state) => state.refreshErrors);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const setDropdownProviderIds = useQuotaStore((state) => state.setDropdownProviderIds);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const toggleModelSelected = useQuotaStore((state) => state.toggleModelSelected);
  const applyDefaultSelections = useQuotaStore((state) => state.applyDefaultSelections);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadSettings();
    void fetchAllQuotas();
  }, [loadSettings, fetchAllQuotas]);

  React.useEffect(() => {
    if (selectedProviderId) {
      return;
    }
    if (results.length === 0) {
      return;
    }
    const firstConfigured = results.find((entry) => entry.configured)?.providerId;
    setSelectedProvider(firstConfigured ?? QUOTA_PROVIDERS[0]?.id ?? null);
  }, [results, selectedProviderId, setSelectedProvider]);

  const selectedResult = results.find((entry) => entry.providerId === selectedProviderId) ?? null;

  const providerMeta = QUOTA_PROVIDERS.find((provider) => provider.id === selectedProviderId);
  const providerName = providerMeta?.name ?? selectedProviderId ?? t('settings.usage.sidebar.title');
  const usage = selectedResult?.usage;
  const refreshError = selectedProviderId ? refreshErrors[selectedProviderId] : undefined;
  const selectedProviderError = refreshError
    ? usage
      ? t('header.services.usageRefreshFailedStale', { error: refreshError })
      : refreshError
    : selectedResult?.configured && !selectedResult.ok
      ? selectedResult.error
      : null;
  const showInDropdown = selectedProviderId ? dropdownProviderIds.includes(selectedProviderId) : false;
  const handleDropdownToggle = React.useCallback((enabled: boolean) => {
    if (!selectedProviderId) {
      return;
    }
    const next = enabled
      ? Array.from(new Set([...dropdownProviderIds, selectedProviderId]))
      : dropdownProviderIds.filter((id) => id !== selectedProviderId);
    setDropdownProviderIds(next);
    void updateDesktopSettings({ usageDropdownProviders: next });
  }, [dropdownProviderIds, selectedProviderId, setDropdownProviderIds]);

  const providerModels = React.useMemo((): ModelInfo[] => {
    if (!usage?.models) return [];
    return Object.entries(usage.models).flatMap(([name, modelUsage]) => {
      const first = Object.entries(modelUsage.windows)[0];
      return first ? [{ name, label: first[0], window: first[1] }] : [];
    });
  }, [usage?.models]);

  React.useEffect(() => {
    if (selectedProviderId && providerModels.length > 0) {
      applyDefaultSelections(selectedProviderId, providerModels.map((m) => m.name));
    }
  }, [selectedProviderId, providerModels, applyDefaultSelections]);

  const handleModelToggle = React.useCallback((modelName: string) => {
    if (!selectedProviderId) return;
    toggleModelSelected(selectedProviderId, modelName);
    const currentSelected = selectedModels[selectedProviderId] ?? [];
    const isSelected = currentSelected.includes(modelName);
    const nextSelected = isSelected
      ? currentSelected.filter((m) => m !== modelName)
      : [...currentSelected, modelName];
    const nextSettings: Record<string, string[]> = { ...selectedModels, [selectedProviderId]: nextSelected };
    void updateDesktopSettings({ usageSelectedModels: nextSettings });
  }, [selectedProviderId, selectedModels, toggleModelSelected]);

  const providerSelectedModels = selectedProviderId ? (selectedModels[selectedProviderId] ?? []) : [];

  if (!selectedProviderId) {
    return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="typography-ui-label">{t('settings.usage.page.empty.selectProvider')}</p>
      </div>
    );
  }

  return (
    <SettingsPageLayout
      title={t('settings.usage.page.header.providerUsage', { provider: providerName })}
      titleLeading={<ProviderLogo providerId={selectedProviderId} className="h-5 w-5 shrink-0" />}
      description={
        isLoading ? (
          <span className={cn('typography-settings-description text-muted-foreground', blink)}>{t('settings.usage.page.header.refreshing')}</span>
        ) : selectedResult?.planLabel ? (
          t('settings.usage.page.header.lastUpdatedWithPlan', {
            plan: selectedResult.planLabel,
            time: formatTime(lastUpdated, timeFormatPreference),
          })
        ) : (
          t('settings.usage.page.header.lastUpdated', { time: formatTime(lastUpdated, timeFormatPreference) })
        )
      }
      showSaveStatus
    >
      <SettingsSection divider={false} settingsItem="usage.work-status-panel">
        <SettingsCheckboxRow
          checked={showInDropdown}
          onChange={handleDropdownToggle}
          label={t('settings.usage.page.options.showInWorkStatus')}
          ariaLabel={t('settings.usage.page.options.showInWorkStatusAria')}
          info={t('settings.usage.page.options.showInWorkStatusTooltip')}
        />
      </SettingsSection>

      {!selectedResult && (
        <p className="typography-ui-label text-foreground pb-8">{t('settings.usage.page.state.noData')}</p>
      )}

      {/* Only the selected provider's own failure belongs in its panel. The
          store's global `error` is whichever provider failed first and has no
          UI consumer left; shown here it labeled one provider with another's
          rate-limit message. */}
      {selectedProviderError && (
        <div className="mb-8 rounded-lg bg-[var(--status-error-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>
          <p className="typography-meta text-[var(--status-error)]/80 mt-1">{selectedProviderError}</p>
        </div>
      )}

      {selectedResult && !selectedResult.configured && providerMeta && (
        <div className="mb-8 rounded-lg bg-[var(--status-warning-background)] px-4 py-3">
          <CliSignInHint cli={providerMeta.signIn.cli} command={providerMeta.signIn.command} />
        </div>
      )}

      {usage?.windows && Object.keys(usage.windows).length > 0 && (
        <SettingsSection settingsItem="usage.model-quotas">
          <div className="divide-y divide-[var(--surface-subtle)]">
            {Object.entries(usage.windows).map(([label, window]) => (
              <UsageCard key={label} title={label} window={window} />
            ))}
          </div>
        </SettingsSection>
      )}

      {providerModels.length > 0 && (
        <SettingsSection title={t('settings.usage.page.section.modelQuotas')}>
          <div className="divide-y divide-[var(--surface-subtle)]">
            {providerModels.map((model) => (
              <UsageCard
                key={model.name}
                title={model.label}
                subtitle={model.name}
                window={model.window}
                showToggle
                toggleEnabled={providerSelectedModels.includes(model.name)}
                onToggle={() => handleModelToggle(model.name)}
              />
            ))}
          </div>
        </SettingsSection>
      )}

      {selectedResult?.configured && usage && Object.keys(usage.windows ?? {}).length === 0 &&
        providerModels.length === 0 && (
        <div className="pb-8">
          <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</p>
          <p className="typography-meta text-muted-foreground mt-1">{t('settings.usage.page.state.noQuotaWindowsDescription')}</p>
        </div>
      )}
    </SettingsPageLayout>
  );
};

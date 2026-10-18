import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsCard,
  SettingsCardChip,
  SettingsCardPill,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import type { EngineSnapshot } from '@/components/setup-wizard/engineSetupModel';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { deriveCardStatus, type EngineCardStatus } from './engineManagement';
import { SOURCE_LABEL } from './engineLabels';

const CARD_STATUS: Record<Exclude<EngineCardStatus, null>, { label: I18nKey; tone: SettingsCardTone }> = {
  working: { label: 'engines.card.status.working', tone: 'info' },
  'not-installed': { label: 'engines.card.status.notInstalled', tone: 'neutral' },
  update: { label: 'engines.card.status.update', tone: 'info' },
  'signed-out': { label: 'engines.card.status.signedOut', tone: 'warning' },
  ready: { label: 'engines.card.status.ready', tone: 'success' },
};

type EnginesGridProps = {
  snapshots: readonly EngineSnapshot[];
  modelCounts: ReadonlyMap<string, number>;
  error: string | null;
  onSelect: (snapshot: EngineSnapshot) => void;
  onRefresh: () => void;
};

export const EnginesGrid: React.FC<EnginesGridProps> = ({ snapshots, modelCounts, error, onSelect, onRefresh }) => {
  const { t } = useI18n();
  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      description={t('engines.page.description')}
      headerEnd={(
        <div className="flex min-w-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh}>{t('engines.page.refresh')}</Button>
          <Button size="sm" variant="outline" onClick={() => useUIStore.getState().setEngineSetupOpen(true)}>{t('engineSetup.openWizard')}</Button>
        </div>
      )}
      className="[&>section:first-of-type]:pt-8"
    >
      {error ? <p className="mb-3 typography-meta text-[var(--status-error)]">{error}</p> : null}
      <div className={SETTINGS_CARD_GRID_CLASS}>
        {snapshots.map((snapshot) => {
          const { status } = snapshot;
          const cardStatus = deriveCardStatus(snapshot);
          const modelCount = modelCounts.get(status.providerID) ?? 0;
          return (
            <SettingsCard
              key={status.engine}
              icon={<ProviderLogo providerId={status.providerID} className="size-5" />}
              title={status.displayName}
              subtitle={status.version ?? undefined}
              badges={cardStatus ? <SettingsCardPill tone={CARD_STATUS[cardStatus].tone}>{t(CARD_STATUS[cardStatus].label)}</SettingsCardPill> : null}
              footer={(
                <>
                  <span className="inline-flex items-center gap-1" aria-label={t('engines.card.models', { count: modelCount })}>
                    <Icon name="stack" className="size-3.5 opacity-70" aria-hidden />
                    <span className="tabular-nums">{modelCount}</span>
                  </span>
                  {status.installed && status.installSource !== 'unknown' ? <SettingsCardChip>{t(SOURCE_LABEL[status.installSource])}</SettingsCardChip> : null}
                </>
              )}
              onOpen={() => onSelect(snapshot)}
            />
          );
        })}
      </div>
    </SettingsPageLayout>
  );
};

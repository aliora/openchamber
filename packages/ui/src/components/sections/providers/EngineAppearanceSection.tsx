import React from 'react';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { LogoChoiceGrid } from '@/components/ui/LogoChoiceGrid';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import {
  ENGINE_DEFAULT_NAMES,
  ENGINE_LOGO_CHOICES,
  ENGINE_NAME_MAX_LENGTH,
  type AppearanceEngineId,
  type EngineLogo,
} from '@/lib/engineAppearance';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

interface EngineAppearanceSectionProps {
  engine: AppearanceEngineId;
  providerID: string;
}

export const EngineAppearanceSection: React.FC<EngineAppearanceSectionProps> = ({ engine, providerID }) => {
  const { t } = useI18n();
  const entry = useUIStore((state) => state.engineAppearance[engine]);
  const setEngineAppearance = useUIStore((state) => state.setEngineAppearance);
  const [draftName, setDraftName] = React.useState(entry?.name ?? '');
  const name = entry?.name || ENGINE_DEFAULT_NAMES[engine];
  const selectedLogo: EngineLogo = entry?.logo ?? 'default';

  React.useEffect(() => {
    setDraftName(entry?.name ?? '');
  }, [entry?.name]);

  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed !== (entry?.name ?? '')) setEngineAppearance(engine, { ...entry, name: trimmed || undefined });
  };

  return (
    <SettingsSection title={t('engines.appearance.title')} info={t('engines.appearance.info')} contentClassName="space-y-3">
      <SettingsFieldRow label={t('engines.appearance.name')} alignEnd={false}>
        <Input
          value={draftName}
          maxLength={ENGINE_NAME_MAX_LENGTH}
          placeholder={ENGINE_DEFAULT_NAMES[engine]}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className="max-w-56"
        />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('engines.appearance.logo')} alignEnd={false}>
        <LogoChoiceGrid
          choices={ENGINE_LOGO_CHOICES}
          selected={selectedLogo}
          name={name}
          ariaLabel={t('engines.appearance.logo')}
          defaultLabel={t('engines.appearance.logo.default')}
          renderDefault={() => <ProviderLogo providerId={providerID} ignoreCustomIcon className="size-4" />}
          onSelect={(logo) => setEngineAppearance(engine, { ...entry, logo: logo === 'default' ? undefined : logo })}
        />
      </SettingsFieldRow>
    </SettingsSection>
  );
};

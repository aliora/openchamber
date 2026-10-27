import React from 'react';
import { SettingsCheckboxRow, SettingsSection, SETTINGS_OPTION_STACK_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/**
 * What the sidebar lists: "In work" (the sidebar block, the Track / Done
 * actions, and sessions going in on a sent message). Jev
 * decides nothing here (it only hints that work looks done, which the info
 * explains), so no Jev access note.
 */
export const SessionWorkSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.sessionWorkEnabled);
  const setEnabled = useUIStore((state) => state.setSessionWorkEnabled);

  return (
    <SettingsSection
      title={t('settings.layout.sessions.sidebar.title')}
      settingsItem="sessions.work"
      contentClassName={SETTINGS_OPTION_STACK_CLASS}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.work-enabled"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.sessionWork.field.enabled')}
        ariaLabel={t('settings.openchamber.sessionWork.field.enabled')}
        info={t('settings.openchamber.sessionWork.info')}
      />
    </SettingsSection>
  );
};

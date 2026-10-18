import React from 'react';
import { toast } from '@/components/ui';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { EnvironmentVariablesEditor } from '@/components/sections/shared/EnvironmentVariablesEditor';
import { fetchUserEnvironment, updateUserEnvironment, type EnvironmentVariablesPatch } from '@/lib/environmentApi';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; names: string[] }
  | { state: 'failed' };

/**
 * Variables for everything OpenChamber starts: OpenCode, Git, the terminal and
 * project actions. OpenCode reads its environment once, at start, so a change
 * reaches it after a restart; Git and the terminal get it on their next run.
 */
export const EnvironmentVariablesSettings: React.FC = () => {
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const [load, setLoad] = React.useState<LoadState>({ state: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    fetchUserEnvironment()
      .then((environment) => {
        if (!cancelled) setLoad({ state: 'ready', names: environment.names });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = React.useCallback(async (patch: EnvironmentVariablesPatch): Promise<boolean> => {
    reportSettingsSaveState('saving');
    try {
      const environment = await updateUserEnvironment(patch);
      setLoad({ state: 'ready', names: environment.names });
      reportSettingsSaveState('saved');
      return true;
    } catch {
      reportSettingsSaveState('error');
      toast.error(t('settings.environment.editor.saveFailed'));
      return false;
    }
  }, [t]);

  return (
    <SettingsSection
      title={t('settings.environment.user.title')}
      info={t('settings.environment.user.info')}
      settingsItem="general.environment-variables"
    >
      <div className="space-y-3">
        {enterpriseMode ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.user.enterpriseNote')}</p>
        ) : null}
        {load.state === 'failed' ? (
          <p className="typography-meta text-[var(--status-error)]">{t('settings.environment.editor.loadFailed')}</p>
        ) : (
          <EnvironmentVariablesEditor
            names={load.state === 'ready' ? load.names : []}
            disabled={load.state !== 'ready'}
            onSet={(name, value) => save({ [name]: value })}
            onRemove={(name) => save({ [name]: null })}
          />
        )}
      </div>
    </SettingsSection>
  );
};

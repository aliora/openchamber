import React from 'react';
import { loadDesktopSettings } from '@/lib/persistence';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { SetupWizard } from './SetupWizard';

export const SetupWizardHost: React.FC = () => {
  const open = useUIStore((state) => state.isEngineSetupOpen);
  const setOpen = useUIStore((state) => state.setEngineSetupOpen);
  const enterpriseMode = useEnterpriseMode();

  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopSettings()
      .then((settings) => {
        if (!cancelled && settings && settings.engineSetupCompleted !== true) setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setOpen]);

  if (!open) return null;
  return <SetupWizard open enterpriseMode={enterpriseMode} onClose={() => setOpen(false)} />;
};

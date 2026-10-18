import React from 'react';
import { MobileSetupWizard } from '@/components/setup-wizard/MobileSetupWizard';
import { shouldOpenEngineSetup } from '@/components/setup-wizard/engineSetupModel';
import { useEngineSetupStore } from '@/components/setup-wizard/useEngineSetupStore';
import { loadDesktopSettings } from '@/lib/persistence';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { takeEngineSetupCheck } from './mobileEngineSetupCheck';

const openIfServerNeedsSetup = async (): Promise<void> => {
  const [settings] = await Promise.all([loadDesktopSettings(), useEngineSetupStore.getState().refresh()]);
  const { snapshots, loaded } = useEngineSetupStore.getState();
  if (!loaded) return;
  if (shouldOpenEngineSetup([...snapshots.values()], { setupCompleted: settings?.engineSetupCompleted === true })) {
    useUIStore.getState().setEngineSetupOpen(true);
  }
};

export const MobileSetupWizardHost: React.FC<{ workspaceOpen: boolean }> = ({ workspaceOpen }) => {
  const open = useUIStore((state) => state.isEngineSetupOpen);
  const setOpen = useUIStore((state) => state.setEngineSetupOpen);
  const enterpriseMode = useEnterpriseMode();
  const [suspended, setSuspended] = React.useState(false);
  const closingRef = React.useRef(false);
  const workspaceWasOpenRef = React.useRef(workspaceOpen);

  React.useEffect(() => {
    if (takeEngineSetupCheck()) void openIfServerNeedsSetup().catch(() => undefined);
  }, []);

  React.useEffect(() => useUIStore.subscribe((state, previous) => {
    if (!previous.isEngineSetupOpen || state.isEngineSetupOpen) return;
    setSuspended(!closingRef.current);
    closingRef.current = false;
  }), []);

  React.useEffect(() => {
    const workspaceClosed = workspaceWasOpenRef.current && !workspaceOpen;
    workspaceWasOpenRef.current = workspaceOpen;
    if (workspaceClosed && suspended && !open) setOpen(true);
  }, [open, setOpen, suspended, workspaceOpen]);

  const close = React.useCallback(() => {
    closingRef.current = true;
    setSuspended(false);
    setOpen(false);
  }, [setOpen]);

  if (!open && !suspended) return null;
  return <MobileSetupWizard open={open} enterpriseMode={enterpriseMode} onClose={close} />;
};

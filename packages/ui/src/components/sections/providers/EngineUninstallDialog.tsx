import React from 'react';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

type EngineUninstallDialogProps = {
  engineName: string | null;
  onCancel: () => void;
  onConfirm: (removeConfig: boolean) => void;
};

export const EngineUninstallDialog: React.FC<EngineUninstallDialogProps> = ({ engineName, onCancel, onConfirm }) => {
  const { t } = useI18n();
  const [removeConfig, setRemoveConfig] = React.useState(false);
  const open = engineName !== null;

  React.useEffect(() => {
    if (open) setRemoveConfig(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('engines.uninstall.title', { engine: engineName ?? '' })}</DialogTitle>
          <DialogDescription>{t('engines.uninstall.message')}</DialogDescription>
        </DialogHeader>
        <SettingsCheckboxRow
          checked={removeConfig}
          onChange={setRemoveConfig}
          label={t('engines.uninstall.removeConfig')}
          description={t('engines.uninstall.removeConfigHint')}
        />
        <DialogFooter>
          <Button size="sm" variant="outline" autoFocus onClick={onCancel}>{t('dialog.common.actions.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={() => onConfirm(removeConfig)}>{t('engines.uninstall.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

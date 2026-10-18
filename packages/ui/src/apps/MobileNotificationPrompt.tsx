import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

import {
  markNotificationPromptDecided,
  readNotificationPromptDecided,
  shouldOfferNotificationPrompt,
} from './notificationPromptGate';

const SETTLE_DELAY_MS = 2_000;

const PROMPT_ITEM_KEYS = [
  'mobile.notificationPrompt.itemInput',
  'mobile.notificationPrompt.itemDone',
  'mobile.notificationPrompt.itemTasks',
] as const;

export const MobileNotificationPrompt: React.FC<{ ready: boolean }> = ({ ready }) => {
  const { t } = useI18n();
  const nativeNotificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const setNativeNotificationsEnabled = useUIStore((state) => state.setNativeNotificationsEnabled);
  const engineSetupOpen = useUIStore((state) => state.isEngineSetupOpen);
  const [decided, setDecided] = React.useState(readNotificationPromptDecided);
  const [settled, setSettled] = React.useState(false);

  React.useEffect(() => {
    if (!ready || settled) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, settled]);

  const decide = React.useCallback((enable: boolean) => {
    markNotificationPromptDecided();
    setDecided(true);
    if (enable) setNativeNotificationsEnabled(true);
  }, [setNativeNotificationsEnabled]);

  const open = shouldOfferNotificationPrompt({ ready: ready && settled, decided, nativeNotificationsEnabled, engineSetupOpen });

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => { if (!next) decide(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mobile.notificationPrompt.title')}</DialogTitle>
          <DialogDescription>{t('mobile.notificationPrompt.description')}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 ps-5 typography-body text-foreground">
          {PROMPT_ITEM_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
        <p className="typography-meta text-muted-foreground">{t('mobile.notificationPrompt.footnote')}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => decide(false)}>
            {t('mobile.notificationPrompt.notNow')}
          </Button>
          <Button variant="default" autoFocus onClick={() => decide(true)}>
            {t('mobile.notificationPrompt.enable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

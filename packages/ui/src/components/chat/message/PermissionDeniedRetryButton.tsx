import React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { resolveSessionSendConfig } from '@/hooks/useQueuedMessageAutoSend';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import { ANTIGRAVITY_FULL_PERMISSION_MODE, findPromptBefore, hasPromptAfter, offersFullPermissionRetry } from './permissionDeniedRetry';

const retryWithFullPermission = async (sessionId: string, messageId: string): Promise<void> => {
  const store = useSessionUIStore.getState();
  const directory = store.getDirectoryForSession(sessionId) ?? undefined;
  const prompt = findPromptBefore(getSyncMessages(sessionId, directory), messageId, (id) => getSyncParts(id, directory));
  const { providerID, modelID, agent, variant } = resolveSessionSendConfig(sessionId);
  if (!prompt || !providerID || !modelID) throw new Error('Nothing to resend');
  await useEngineControlsStore.getState().setSessionPermissionMode(sessionId, ANTIGRAVITY_FULL_PERMISSION_MODE);
  await store.sendMessage(prompt, providerID, modelID, agent, undefined, undefined, undefined, variant, 'normal', { sessionId, directory });
};

export const PermissionDeniedRetryButton: React.FC<{ sessionId: string; messageId: string; errorType: string | undefined }> = ({
  sessionId,
  messageId,
  errorType,
}) => {
  const { t } = useI18n();
  const engine = useEngineControlsStore((state) => state.sessions.get(sessionId)?.engine);
  const { isWorking } = useSessionActivity(sessionId);
  const directory = useSessionUIStore((state) => state.getDirectoryForSession(sessionId)) ?? undefined;
  const isRetried = useSessionMessagesSelector(sessionId, directory, (messages) => hasPromptAfter(messages, messageId));
  const [isRetrying, setIsRetrying] = React.useState(false);

  React.useEffect(() => {
    if (engine || errorType !== 'PermissionDenied') return;
    void useEngineControlsStore.getState().loadSession(sessionId);
  }, [engine, errorType, sessionId]);

  const handleClick = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await retryWithFullPermission(sessionId, messageId);
    } catch (error) {
      console.error('[PermissionDeniedRetry] Failed to retry with full permissions:', error);
      toast.error(t('chat.permissionDenied.grantFullFailed'));
    } finally {
      setIsRetrying(false);
    }
  }, [messageId, sessionId, t]);

  if (isRetried || !offersFullPermissionRetry(engine, errorType)) return null;

  return (
    <div className="mt-2 ps-7">
      <Button variant="outline" size="xs" disabled={isWorking || isRetrying} onClick={() => void handleClick()}>
        {isRetrying ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="lock-unlock" className="size-3.5" />}
        {t('chat.permissionDenied.grantFullAndRetry')}
      </Button>
    </div>
  );
};

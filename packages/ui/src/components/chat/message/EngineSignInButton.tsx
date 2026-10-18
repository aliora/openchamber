import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { EngineSignInDialog } from '@/components/setup-wizard/EngineSignInDialog';
import { useI18n } from '@/lib/i18n';
import { useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { isSignInError, signInEngineForError } from './engineSignIn';

type EngineSignInButtonProps = { sessionId: string; errorType: string | undefined; errorText: string | undefined; className?: string };

export const EngineSignInButton: React.FC<EngineSignInButtonProps> = ({
  sessionId,
  errorType,
  errorText,
  className = 'mt-2 ps-7',
}) => {
  const { t } = useI18n();
  const sessionEngine = useEngineControlsStore((state) => state.sessions.get(sessionId)?.engine);
  const engine = signInEngineForError(sessionEngine, errorType, errorText);
  const [open, setOpen] = React.useState(false);
  const needsEngine = !sessionEngine && isSignInError(errorType, errorText);

  React.useEffect(() => {
    if (needsEngine) void useEngineControlsStore.getState().loadSession(sessionId);
  }, [needsEngine, sessionId]);

  if (!engine) return null;

  return (
    <div className={className}>
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        <Icon name="key" className="size-3.5" />
        {t('chat.engineSignIn.button')}
      </Button>
      {open ? <EngineSignInDialog engine={engine} onClose={() => setOpen(false)} /> : null}
    </div>
  );
};

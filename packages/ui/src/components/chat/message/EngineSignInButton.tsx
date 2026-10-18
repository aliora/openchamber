import React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { engineLoginCommand } from '@/components/setup-wizard/engineSetupModel';
import { useEngineSetupStore } from '@/components/setup-wizard/useEngineSetupStore';
import { useRunInTerminal } from '@/hooks/useRunInTerminal';
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
  const snapshot = useEngineSetupStore((state) => (engine ? state.snapshots.get(engine) : undefined));
  const runInTerminal = useRunInTerminal();
  const [isRunning, setIsRunning] = React.useState(false);
  const needsEngine = !sessionEngine && isSignInError(errorType, errorText);

  React.useEffect(() => {
    if (needsEngine) void useEngineControlsStore.getState().loadSession(sessionId);
  }, [needsEngine, sessionId]);

  if (!engine || !runInTerminal) return null;

  const signIn = () => {
    setIsRunning(true);
    if (engine === 'antigravity') toast.info(t('engines.signIn.agyLogin'));
    runInTerminal(engineLoginCommand(engine, snapshot), `engine-${engine}-login`)
      .then(() => useEngineSetupStore.getState().refresh())
      .catch((error: unknown) => {
        toast.error(t('engines.terminal.failed'), { description: error instanceof Error ? error.message : undefined });
      })
      .finally(() => setIsRunning(false));
  };

  return (
    <div className={className}>
      <Button variant="outline" size="xs" disabled={isRunning} onClick={signIn}>
        <Icon name={isRunning ? 'loader-4' : 'terminal'} className={isRunning ? 'size-3.5 animate-spin' : 'size-3.5'} />
        {t('chat.engineSignIn.button')}
      </Button>
    </div>
  );
};

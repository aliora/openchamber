import React from 'react';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useTerminalCommandOptions } from '@/hooks/useRunInTerminal';
import { buildChatCommandContext, runChatCommand, type ChatCommandResult } from '@/lib/chatCommandRun';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { CodeRunContext } from './markdown/codeRunContext';
import type { CodeRunControls } from './markdown/decorate';

const attachToNextMessage = (sessionId: string, directory: string, result: ChatCommandResult): void => {
  const { label, output, lineCount } = buildChatCommandContext(result);
  useInlineCommentDraftStore.getState().addDraft(
    { directory: useSessionUIStore.getState().getDirectoryForSession(sessionId) ?? directory, sessionKey: sessionId },
    {
      source: 'terminal',
      fileLabel: label,
      startLine: 1,
      endLine: lineCount,
      code: output,
      language: '',
      terminalId: result.terminalSessionId,
      text: '',
    },
  );
};

const useChatCommandRun = (sessionId: string | undefined, directory: string): CodeRunControls | undefined => {
  const { terminal, runtime } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const { t } = useI18n();
  const createOptions = useTerminalCommandOptions();
  const enabled = Boolean(sessionId && directory) && !isMobile && !runtime.isVSCode;

  const run = React.useCallback(async (command: string): Promise<boolean> => {
    if (!sessionId || !directory) return false;
    let result: ChatCommandResult;
    try {
      result = await runChatCommand({
        terminal,
        ownerId: sessionId,
        command,
        directory,
        createOptions,
        revealTerminal: () => useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal', targetDirectory: null }),
      });
    } catch (error) {
      toast.error(t('chat.commandRun.startFailed'), { description: error instanceof Error ? error.message : undefined });
      throw error;
    }
    attachToNextMessage(sessionId, directory, result);
    return result.exitCode === 0;
  }, [createOptions, directory, sessionId, t, terminal]);

  return React.useMemo(() => (enabled ? {
    label: t('markdownRenderer.code.actions.runTitle'),
    runningLabel: t('markdownRenderer.code.actions.runningTitle'),
    succeededLabel: t('markdownRenderer.code.actions.runSucceededTitle'),
    failedLabel: t('markdownRenderer.code.actions.runFailedTitle'),
    run,
  } : undefined), [enabled, run, t]);
};

type ChatCommandRunProviderProps = {
  sessionId: string;
  directory: string;
  children: React.ReactNode;
};

export const ChatCommandRunProvider = ({ sessionId, directory, children }: ChatCommandRunProviderProps) => {
  const codeRun = useChatCommandRun(sessionId, directory);
  return <CodeRunContext.Provider value={codeRun}>{children}</CodeRunContext.Provider>;
};

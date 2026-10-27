import { useChatSessionSelection, type ChatColumnSession } from '@/components/chat/chatColumnSession';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** MCP connections belong to the directory that will run the first turn. */
export const useMcpDirectory = (selection?: ChatColumnSession): string | null => {
  const currentSelection = useChatSessionSelection();
  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = selection ? selection.sessionId : currentSelection.sessionId;
  const draftDirectory = useSessionUIStore((state) => state.newSessionDraft.open
    ? state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride
    : null);

  if (selection) return selection.directory;
  if (sessionId) return currentSelection.directory;
  return draftDirectory ?? fallbackDirectory ?? null;
};

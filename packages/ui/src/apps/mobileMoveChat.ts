import { buildSessionTreeMoveMessages, requestSessionTreeMove } from '@/lib/worktrees/sessionWorktreeMove';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

type Translate = Parameters<typeof buildSessionTreeMoveMessages>[0];

export const moveChatToProject = (sessionId: string, sourceDirectory: string, projectDirectory: string, t: Translate): void => {
  const sessions = useGlobalSessionsStore.getState().activeSessions;
  const root = sessions.find((session) => session.id === sessionId);
  if (!root) return;
  const descendants: typeof sessions = [];
  const pendingParentIds = [sessionId];
  for (let index = 0; index < pendingParentIds.length; index += 1) {
    for (const session of sessions) {
      if (session.parentID !== pendingParentIds[index]) continue;
      descendants.push(session);
      pendingParentIds.push(session.id);
    }
  }
  requestSessionTreeMove({
    kind: 'project',
    root,
    descendants,
    sourceDirectory,
    projectDirectory,
    messages: buildSessionTreeMoveMessages(t, {
      success: 'sessions.moveChatToProject.success',
      failure: 'sessions.moveChatToProject.failed',
    }),
  });
};

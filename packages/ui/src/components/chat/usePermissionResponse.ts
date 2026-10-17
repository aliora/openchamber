import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useChatColumnActions, useChatSessionSelection } from './chatColumnSession';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { canSavePermission } from './permissionSummary';

type ColumnKind = 'main' | 'pinned';

// Newest pending card of a chat owns that chat's keyboard; older cards wait
// their turn. With a chat pinned in the side panel, each chat answers only the
// keys pressed inside it (anywhere else counts as the main chat).
const activePermissionCards: Array<{ id: string; column: ColumnKind }> = [];

const columnOfEvent = (event: KeyboardEvent): ColumnKind => (
  event.target instanceof Element && event.target.closest('[data-chat-column="pinned"]') ? 'pinned' : 'main'
);

/**
 * The reply a key press gives: Alt+Enter allows once, Alt+Shift+Enter always
 * (only when the request has something to save), Alt+Backspace denies.
 */
export const permissionShortcutReply = (
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  canSave: boolean,
): PermissionReply | null => {
  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.key === 'Enter') return event.shiftKey ? (canSave ? 'always' : null) : 'once';
  if (event.key === 'Backspace' && !event.shiftKey) return 'reject';
  return null;
};

export const isAllowAllShortcut = (
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
): boolean => event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyA';

type PermissionReplySender = (sessionId: string, requestId: string, reply: PermissionReply) => Promise<void>;

export const allowAllPermissions = async (
  permissions: ReadonlyArray<Pick<PermissionRequest, 'id' | 'sessionID'>>,
  send: PermissionReplySender,
): Promise<number> => {
  const results = await Promise.allSettled(permissions.map((permission) => send(permission.sessionID, permission.id, 'once')));
  return results.filter((result) => result.status === 'rejected').length;
};

export const useAllowAllPermissions = (permissions: PermissionRequest[]) => {
  const column: ColumnKind = useChatColumnActions().pinned ? 'pinned' : 'main';
  const [isAllowingAll, setIsAllowingAll] = React.useState(false);
  const permissionsRef = React.useRef(permissions);
  permissionsRef.current = permissions;
  const canAllowAll = permissions.length > 1;

  const allowAll = React.useCallback(async () => {
    setIsAllowingAll(true);
    try {
      const failed = await allowAllPermissions(permissionsRef.current, sessionActions.respondToPermission);
      if (failed > 0) console.error(`[PermissionDock] ${failed} permission replies failed`);
    } finally {
      setIsAllowingAll(false);
    }
  }, []);

  React.useEffect(() => {
    if (!canAllowAll) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (columnOfEvent(event) !== column || !isAllowAllShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void allowAll();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [allowAll, canAllowAll, column]);

  return { canAllowAll, isAllowingAll, allowAll };
};

/** The request was raised by a child of the session the user is looking at. */
export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  const sessions = useSessions(currentSessionDirectory ?? undefined);
  return React.useMemo(() => {
    if (!currentSessionId || permission.sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === permission.sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [permission.sessionID, currentSessionId, sessions]);
};

/**
 * Replies to one request and owns its keyboard shortcuts while it is the
 * newest pending one (see `permissionShortcutReply`). Shared by the inline
 * card and the dock.
 */
export const usePermissionResponse = (
  permission: PermissionRequest,
  onResponse?: (response: PermissionReply) => void,
) => {
  const column: ColumnKind = useChatColumnActions().pinned ? 'pinned' : 'main';
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;
  const canSave = canSavePermission(permission.save);

  const respond = React.useCallback(async (response: PermissionReply) => {
    setIsResponding(true);
    try {
      await respondToPermission(permission.sessionID, permission.id, response);
      setHasResponded(true);
      onResponse?.(response);
    } catch (error) {
      console.error('[PermissionCard] Failed to respond to permission:', error);
    } finally {
      setIsResponding(false);
    }
  }, [onResponse, permission.id, permission.sessionID, respondToPermission]);

  const respondRef = React.useRef(respond);
  respondRef.current = respond;

  React.useEffect(() => {
    if (hasResponded) return;
    const card = { id: permission.id, column };
    activePermissionCards.push(card);
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = columnOfEvent(event);
      let owner: typeof card | undefined;
      for (const entry of activePermissionCards) {
        if (entry.column === target) owner = entry;
      }
      if (owner !== card) return;
      const response = permissionShortcutReply(event, canSave);
      if (!response) return;
      event.preventDefault();
      event.stopPropagation();
      void respondRef.current(response);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const index = activePermissionCards.lastIndexOf(card);
      if (index !== -1) activePermissionCards.splice(index, 1);
    };
  }, [canSave, column, hasResponded, permission.id]);

  return { isResponding, hasResponded, respond };
};

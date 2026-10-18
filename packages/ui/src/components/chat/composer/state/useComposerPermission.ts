/**
 * The composer's permission control on a server whose sessions run on
 * engines: the permission modes of the session's engine and the one in force.
 *
 * - A session shows its stored mode, read from its record, and a pick is
 *   stored on the server at once (`PATCH /api/session/:id`). Claude takes most
 *   modes in the running process; any other mode reaches the CLI with the next
 *   prompt.
 * - A new-session draft shows the modes of the engine of the model picked in
 *   the composer and keeps the pick in the draft until the session exists.
 *   A pick made for another engine's model is carried as the server carries
 *   a chat's mode to another engine (`carriedPermissionMode`).
 *
 * A server without engines answers `shield`: OpenChamber's own auto-accept is
 * the permission control there.
 */
import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  carriedPermissionMode,
  findEngineForProvider,
  PermissionModeChangeError,
  useEngineControlsStore,
  type EngineControls,
  type EnginePermissionModeOption,
} from '@/stores/useEngineControlsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type ComposerPermission =
  | { kind: 'shield' }
  | { kind: 'pending' }
  | {
    kind: 'engine';
    engine: EngineControls;
    mode: EnginePermissionModeOption;
    select: (modeId: string) => void;
  };

const SHIELD: ComposerPermission = { kind: 'shield' };
const PENDING: ComposerPermission = { kind: 'pending' };

/** A mode the engine does not list, such as one stored by an older server, keeps its id and no text. */
const unlistedMode = (id: string): EnginePermissionModeOption => ({
  id,
  labelKey: '',
  descriptionKey: '',
  dangerous: false,
  appliesLive: false,
});

/**
 * The mode the permission shortcut moves to: the next one in the engine's
 * order, skipping dangerous modes, which are only ever picked by hand.
 */
export const nextCycledPermissionMode = (engine: EngineControls, currentId: string): string | null => {
  const safe = engine.permissionModes.filter((mode) => !mode.dangerous);
  if (safe.length === 0) return null;
  const index = safe.findIndex((mode) => mode.id === currentId);
  return safe[(index + 1) % safe.length]?.id ?? null;
};

interface ComposerPermissionArgs {
  /** The session the composer sends to, or null for a draft. */
  sessionId: string | null;
  draftOpen: boolean;
  /** The provider of the model picked in the composer; it names the draft's engine. */
  providerId: string | null;
}

export const useComposerPermission = ({ sessionId, draftOpen, providerId }: ComposerPermissionArgs): ComposerPermission => {
  const { t } = useI18n();
  const status = useEngineControlsStore((state) => state.status);
  const catalog = useEngineControlsStore((state) => state.catalog);
  const sessionSettings = useEngineControlsStore((state) => (sessionId ? state.sessions.get(sessionId) ?? null : null));
  const draftEngineMode = useSessionUIStore((state) => (state.newSessionDraft?.open ? state.newSessionDraft.enginePermissionMode : undefined));

  // A failed read is retried when the composer moves to another session.
  React.useEffect(() => {
    const { status: current, load } = useEngineControlsStore.getState();
    if (current === 'idle' || current === 'failed') void load();
  }, [sessionId]);

  // Read on every session switch, and when the picked model changes: a chat
  // without messages moves to the engine of a model picked from another one.
  React.useEffect(() => {
    if (status !== 'ready' || !sessionId) return;
    void useEngineControlsStore.getState().loadSession(sessionId);
  }, [providerId, sessionId, status]);

  return React.useMemo<ComposerPermission>(() => {
    if (status === 'unsupported') return SHIELD;
    if (status !== 'ready' || !catalog) return PENDING;

    if (sessionId) {
      const engine = sessionSettings
        ? catalog.engines.find((candidate) => candidate.engine === sessionSettings.engine)
        : undefined;
      if (!sessionSettings || !engine) return PENDING;
      return {
        kind: 'engine',
        engine,
        mode: engine.permissionModes.find((mode) => mode.id === sessionSettings.permissionMode) ?? unlistedMode(sessionSettings.permissionMode),
        select: (modeId) => {
          void useEngineControlsStore.getState().setSessionPermissionMode(sessionId, modeId).catch((error) => {
            toast.error(error instanceof PermissionModeChangeError && error.reason
              ? t('chat.composer.permission.changeFailedWithReason', { reason: error.reason })
              : t('chat.composer.permission.changeFailed'));
          });
        },
      };
    }

    if (!draftOpen) return PENDING;
    const engine = findEngineForProvider(catalog, providerId)
      ?? catalog.engines.find((candidate) => candidate.engine === catalog.defaultEngine);
    if (!engine) return PENDING;
    const carried = carriedPermissionMode(catalog, draftEngineMode, engine);
    const mode = engine.permissionModes.find((option) => option.id === carried);
    if (!mode) return PENDING;
    return {
      kind: 'engine',
      engine,
      mode,
      select: (modeId) => useSessionUIStore.getState().setDraftEnginePermissionMode(engine.engine, modeId),
    };
  }, [catalog, draftEngineMode, draftOpen, providerId, sessionId, sessionSettings, status, t]);
};

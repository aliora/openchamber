import { openSessionInOwningHostWindow } from '@/lib/desktop';
import { switchToDesktopHost } from '@/lib/desktopHostActions';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openDraftInDirectory } from './open-host-draft';
import type { HostDescriptor } from './types';

/** What opens once the window is on the host. */
export type HostOpenTarget =
  | { kind: 'session'; sessionId: string; directory: string }
  | { kind: 'draft'; directory?: string };

/**
 * Why nothing opened, for the caller to tell the user: `failed` the focus did
 * not move to the host, `missing` the host's complete list no longer has the
 * session.
 */
export type HostOpenProblem = 'failed' | 'missing';

export type HostOpenRequest = {
  host: HostDescriptor;
  target: HostOpenTarget;
  onProblem: (problem: HostOpenProblem) => void;
};

type HostOpenResult = 'opened' | 'superseded' | HostOpenProblem;

type GlobalSessionsView = {
  complete: boolean;
  hasSession: (sessionId: string) => boolean;
};

export type HostSessionOpenerDependencies = {
  getActiveRuntimeKey: () => string;
  /** Moves the focus to the host. Rejects when it cannot; the focus stays where it was. */
  focusHost: (host: HostDescriptor) => Promise<void>;
  readGlobalSessions: () => GlobalSessionsView;
  selectSession: (sessionId: string, directory: string) => void;
  openDraft: (directory?: string) => void;
  /** Opens the session in the host's own window; false where the shell cannot. */
  openInHostWindow: (runtimeKey: string, sessionId: string) => boolean;
};

export const createHostSessionOpener = (deps: HostSessionOpenerDependencies) => {
  let latest = 0;
  let focusing: Promise<unknown> = Promise.resolve();

  const show = (target: HostOpenTarget, onProblem: (problem: HostOpenProblem) => void): HostOpenResult => {
    if (target.kind === 'draft') {
      deps.openDraft(target.directory);
      return 'opened';
    }
    const sessions = deps.readGlobalSessions();
    if (sessions.complete && !sessions.hasSession(target.sessionId)) {
      onProblem('missing');
      return 'missing';
    }
    deps.selectSession(target.sessionId, target.directory);
    return 'opened';
  };

  return {
    open({ host, target, onProblem }: HostOpenRequest): Promise<HostOpenResult> {
      latest += 1;
      const id = latest;
      const run = focusing.then(async (): Promise<HostOpenResult> => {
        if (id !== latest) return 'superseded';
        if (deps.getActiveRuntimeKey() !== host.runtimeKey) {
          await deps.focusHost(host).catch(() => undefined);
          if (deps.getActiveRuntimeKey() !== host.runtimeKey) {
            onProblem('failed');
            return 'failed';
          }
        }
        if (id !== latest) return 'superseded';
        return show(target, onProblem);
      });
      focusing = run.catch(() => undefined);
      return run;
    },

    openInHostWindow(host: HostDescriptor, sessionId: string): boolean {
      return deps.openInHostWindow(host.runtimeKey, sessionId);
    },

    /** A session the user picked on the focused host wins over an open still waiting for its focus move. */
    supersede(): void {
      latest += 1;
    },
  };
};

const closeFullPageSurfaces = (): void => {
  useUIStore.getState().closeMainSurfaces();
};

export const hostSessionOpenerDependencies: HostSessionOpenerDependencies = {
  getActiveRuntimeKey: getRuntimeKey,
  focusHost: (host) => switchToDesktopHost(host.id),
  readGlobalSessions: () => {
    const state = useGlobalSessionsStore.getState();
    return {
      complete: state.hasLoaded && state.status === 'ready',
      hasSession: (sessionId) => state.entityById.has(sessionId),
    };
  },
  selectSession: (sessionId, directory) => {
    closeFullPageSurfaces();
    useSessionUIStore.getState().setCurrentSession(sessionId, directory);
  },
  openDraft: (directory) => {
    closeFullPageSurfaces();
    openDraftInDirectory(directory);
  },
  openInHostWindow: (runtimeKey, sessionId) => openSessionInOwningHostWindow(sessionId, runtimeKey),
};

export type HostSessionOpener = ReturnType<typeof createHostSessionOpener>;

export const hostSessionOpener: HostSessionOpener = createHostSessionOpener(hostSessionOpenerDependencies);

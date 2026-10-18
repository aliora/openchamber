// Opens a session of another host from the sidebar, or a new draft there.
//
// The window talks to one host at a time, so opening a monitored host's
// session switches the window to that host first, through the same switch the
// host switcher uses. The wanted session waits, keyed by the host's runtime
// key, until the new host's first complete global session list arrives; then
// it opens, or a missing session is reported and the window stays where the
// switch left it. A switch that does not happen keeps the current host.
//
// Switches run one after another. A click while a switch to the same host is
// under way only changes what opens at the end; a click on another host waits
// for the running switch and then moves on, so the last click wins.

import { openHostSession as openDesktopHostSession } from '@/lib/desktop';
import { switchToDesktopHost } from '@/lib/desktopHostActions';
import { hasUnsentComposerDraft } from '@/lib/composerDraftProbe';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openDraftInDirectory } from './open-host-draft';
import type { HostConnection, HostDescriptor } from './types';

/** What opens once the window is on the host. */
export type HostOpenTarget =
  | { kind: 'session'; sessionId: string; directory: string }
  | { kind: 'draft'; directory?: string };

/**
 * Why nothing opened, for the caller to tell the user:
 * `unreachable` the host does not answer now, `connecting` its first answer
 * has not arrived, `failed` the switch did not happen, `missing` the session
 * is not on the host any more.
 */
export type HostOpenProblem = 'unreachable' | 'connecting' | 'failed' | 'missing';

export type HostOpenRequest = {
  host: HostDescriptor;
  /** The monitor's view of the host; the window switches only to a host that answers. */
  connection: HostConnection;
  target: HostOpenTarget;
  /** Asked before leaving a composer that holds an unsent message. True switches. */
  confirmLeavingDraft: () => Promise<boolean>;
  /** Told when nothing opens, now or once the host's list arrives. */
  onProblem: (problem: HostOpenProblem) => void;
};

/**
 * `opened` on the active host at once, `pending` until the switched-to host's
 * list arrives, `cancelled` when the user kept their draft, `superseded` when
 * a later click replaced this one before its switch started.
 */
type HostOpenResult = 'opened' | 'pending' | 'cancelled' | 'superseded' | HostOpenProblem;

type GlobalSessionsView = {
  /** A complete list of the active runtime arrived. */
  complete: boolean;
  hasSession: (sessionId: string) => boolean;
};

export type HostSessionOpenerDependencies = {
  getActiveRuntimeKey: () => string;
  /** Moves the window to the host. Rejects when it cannot; the window stays where it was. */
  switchToHost: (host: HostDescriptor) => Promise<void>;
  subscribeRuntimeChanged: (listener: (runtimeKey: string, previousRuntimeKey: string) => void) => () => void;
  readGlobalSessions: () => GlobalSessionsView;
  subscribeGlobalSessions: (listener: () => void) => () => void;
  selectSession: (sessionId: string, directory: string) => void;
  openDraft: (directory?: string) => void;
  hasUnsentDraft: () => boolean;
  /** Opens the session in the host's own window; false where the shell cannot. */
  openInHostWindow: (runtimeKey: string, sessionId: string) => boolean;
  /** Ends the wait for the switched-to host's list: the target then opens unchecked. Returns a cancel. */
  scheduleSessionsTimeout?: (onTimeout: () => void) => () => void;
};

type PendingOpen = {
  id: number;
  runtimeKey: string;
  target: HostOpenTarget;
  onProblem: (problem: HostOpenProblem) => void;
  /** The window reached the host; its list is the one to wait for. */
  arrived: boolean;
  /** The list was seen incomplete after the arrival, so a complete one is the new host's. */
  sawIncomplete: boolean;
};

/** Hosts the window can move to: they answer, or answer that the user has to sign in or update. */
const canSwitchTo = (connection: HostConnection): HostOpenProblem | null => {
  switch (connection.state) {
    case 'live':
    case 'auth-required':
    case 'incompatible':
      return null;
    case 'connecting':
      return 'connecting';
    default:
      return 'unreachable';
  }
};

export const createHostSessionOpener = (deps: HostSessionOpenerDependencies) => {
  let pending: PendingOpen | null = null;
  let nextId = 0;
  let switches: Promise<unknown> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  let cancelTimeout: (() => void) | null = null;

  const stopWaiting = (): void => {
    pending = null;
    unsubscribe?.();
    unsubscribe = null;
    cancelTimeout?.();
    cancelTimeout = null;
  };

  const show = (target: HostOpenTarget): void => {
    if (target.kind === 'draft') deps.openDraft(target.directory);
    else deps.selectSession(target.sessionId, target.directory);
  };

  const apply = (target: HostOpenTarget, onProblem: (problem: HostOpenProblem) => void): HostOpenResult => {
    if (target.kind === 'session' && !deps.readGlobalSessions().hasSession(target.sessionId)) {
      onProblem('missing');
      return 'missing';
    }
    show(target);
    return 'opened';
  };

  const startTimeout = (entry: PendingOpen): void => {
    cancelTimeout = deps.scheduleSessionsTimeout?.(() => {
      if (pending !== entry) return;
      stopWaiting();
      show(entry.target);
    }) ?? null;
  };

  const check = (): void => {
    const current = pending;
    if (!current?.arrived || deps.getActiveRuntimeKey() !== current.runtimeKey) return;
    const sessions = deps.readGlobalSessions();
    if (!sessions.complete) {
      current.sawIncomplete = true;
      return;
    }
    if (!current.sawIncomplete) return;
    stopWaiting();
    apply(current.target, current.onProblem);
  };

  const wait = (entry: PendingOpen): void => {
    pending = entry;
    if (unsubscribe) return;
    const stopStore = deps.subscribeGlobalSessions(check);
    const stopRuntime = deps.subscribeRuntimeChanged((runtimeKey, previousRuntimeKey) => {
      const current = pending;
      if (!current || runtimeKey === previousRuntimeKey) return;
      if (runtimeKey === current.runtimeKey) {
        current.arrived = true;
        startTimeout(current);
        check();
      } else if (current.arrived) {
        // The window left the host before its list arrived: nothing opens.
        stopWaiting();
      }
    });
    unsubscribe = () => {
      stopStore();
      stopRuntime();
    };
  };

  return {
    async open(request: HostOpenRequest): Promise<HostOpenResult> {
      const { host, target, onProblem } = request;
      if (deps.getActiveRuntimeKey() === host.runtimeKey && pending?.runtimeKey !== host.runtimeKey) {
        return apply(target, onProblem);
      }
      // A switch to this host is under way: the latest click decides what opens.
      if (pending && pending.runtimeKey === host.runtimeKey) {
        pending.target = target;
        pending.onProblem = onProblem;
        return 'pending';
      }
      const blocked = canSwitchTo(request.connection);
      if (blocked) {
        onProblem(blocked);
        return blocked;
      }
      if (deps.hasUnsentDraft() && !await request.confirmLeavingDraft()) return 'cancelled';

      nextId += 1;
      const id = nextId;
      wait({ id, runtimeKey: host.runtimeKey, target, onProblem, arrived: false, sawIncomplete: false });
      const run = switches.then(async (): Promise<HostOpenResult> => {
        if (pending?.id !== id) return 'superseded';
        try {
          await deps.switchToHost(host);
        } catch {
          // Reported below: the window is still on the host it was on.
        }
        if (deps.getActiveRuntimeKey() === host.runtimeKey) return 'pending';
        if (pending?.id === id) stopWaiting();
        onProblem('failed');
        return 'failed';
      });
      switches = run.catch(() => undefined);
      return run;
    },

    /** Opens the session in the host's own window. False where the shell cannot. */
    openInHostWindow(host: HostDescriptor, sessionId: string): boolean {
      return deps.openInHostWindow(host.runtimeKey, sessionId);
    },
  };
};

const closeFullPageSurfaces = (): void => {
  useUIStore.getState().closeMainSurfaces();
};

export const hostSessionOpenerDependencies: HostSessionOpenerDependencies = {
  getActiveRuntimeKey: getRuntimeKey,
  switchToHost: (host) => switchToDesktopHost(host.id),
  subscribeRuntimeChanged: (listener) => subscribeRuntimeEndpointChanged((detail) => {
    listener(detail.runtimeKey, detail.previousRuntimeKey);
  }),
  readGlobalSessions: () => {
    const state = useGlobalSessionsStore.getState();
    return {
      complete: state.hasLoaded && state.status === 'ready',
      hasSession: (sessionId) => state.entityById.has(sessionId),
    };
  },
  subscribeGlobalSessions: (listener) => useGlobalSessionsStore.subscribe(listener),
  selectSession: (sessionId, directory) => {
    closeFullPageSurfaces();
    useSessionUIStore.getState().setCurrentSession(sessionId, directory);
  },
  openDraft: (directory) => {
    closeFullPageSurfaces();
    openDraftInDirectory(directory);
  },
  hasUnsentDraft: hasUnsentComposerDraft,
  openInHostWindow: openDesktopHostSession,
};

export type HostSessionOpener = ReturnType<typeof createHostSessionOpener>;

export const hostSessionOpener: HostSessionOpener = createHostSessionOpener(hostSessionOpenerDependencies);

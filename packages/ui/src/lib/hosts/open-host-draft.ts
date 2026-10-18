import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const PROJECTS_WAIT_MS = 10_000;

export type DraftInDirectoryTarget = { projectId: string | null; directory: string | null };

type DraftInDirectoryDependencies = {
  findProjectId: (directory: string) => string | null;
  subscribeProjects: (listener: () => void) => () => void;
  openDraft: (target: DraftInDirectoryTarget) => void;
  scheduleTimeout: (onTimeout: () => void) => () => void;
};

export const createDraftInDirectoryOpener = (deps: DraftInDirectoryDependencies) => {
  let stopWaiting: (() => void) | null = null;

  return (directory?: string): void => {
    stopWaiting?.();
    stopWaiting = null;
    if (!directory) {
      deps.openDraft({ projectId: null, directory: null });
      return;
    }
    const knownProjectId = deps.findProjectId(directory);
    if (knownProjectId) {
      deps.openDraft({ projectId: knownProjectId, directory });
      return;
    }
    let stopProjects = (): void => {};
    let cancelTimeout = (): void => {};
    const stop = (): void => {
      stopProjects();
      cancelTimeout();
      stopWaiting = null;
    };
    const finish = (projectId: string | null): void => {
      stop();
      deps.openDraft({ projectId, directory });
    };
    stopProjects = deps.subscribeProjects(() => {
      const projectId = deps.findProjectId(directory);
      if (projectId) finish(projectId);
    });
    cancelTimeout = deps.scheduleTimeout(() => finish(null));
    stopWaiting = stop;
  };
};

const findProjectId = (directory: string): string | null => {
  const wanted = normalizePath(directory);
  return useProjectsStore.getState().projects.find((project) => normalizePath(project.path) === wanted)?.id ?? null;
};

export const openDraftInDirectory = createDraftInDirectoryOpener({
  findProjectId,
  subscribeProjects: (listener) => useProjectsStore.subscribe(listener),
  openDraft: ({ projectId, directory }) => {
    if (projectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId);
    useSessionUIStore.getState().openNewSessionDraft(directory
      ? { selectedProjectId: projectId, directoryOverride: directory }
      : undefined);
  },
  scheduleTimeout: (onTimeout) => {
    const timeoutId = window.setTimeout(onTimeout, PROJECTS_WAIT_MS);
    return () => window.clearTimeout(timeoutId);
  },
});

import type { ProjectEntry } from '@/lib/api/types';
import type { Session, SessionStatus } from '@/lib/opencode/model';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { HostProject, HostSessionState, HostSessionSummary, HostSnapshot } from '../types';

type PendingRequests = {
  permissions: readonly { id: string }[];
  forms: readonly { id: string }[];
  pages: readonly { id: string }[];
};

export type HostSnapshotInput = {
  activeSessions: readonly Session[];
  hasLoaded: boolean;
  listStatus: 'idle' | 'loading' | 'ready' | 'error';
  statusById: ReadonlyMap<string, { status: SessionStatus }>;
  pendingBySession: ReadonlyMap<string, PendingRequests>;
  projects: readonly ProjectEntry[] | null;
  defaultProjectId: string | null;
};

const EMPTY_SESSIONS: ReadonlyMap<string, HostSessionSummary> = new Map();

const sameSummary = (left: HostSessionSummary, right: HostSessionSummary): boolean => (
  left.id === right.id
  && left.parentID === right.parentID
  && left.title === right.title
  && left.directory === right.directory
  && left.providerId === right.providerId
  && left.updatedAt === right.updatedAt
  && left.state === right.state
  && left.outcome === right.outcome
  && left.chat === right.chat
  && left.projectId === right.projectId
  && left.work === right.work
);

const folderName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

const toHostProjects = (projects: readonly ProjectEntry[], defaultProjectId: string | null): HostProject[] => (
  projects.map((project, order) => ({
    id: project.id,
    label: project.label?.trim() || folderName(project.path),
    path: project.path,
    order,
    isDefault: project.id === defaultProjectId,
  }))
);

const containsDirectory = (projectPath: string, directory: string): boolean => {
  const root = projectPath.replace(/\/+$/, '');
  return directory === root || directory.startsWith(`${root}/`);
};

const projectIdOf = (directory: string, projects: readonly HostProject[]): string | null => {
  let match: HostProject | null = null;
  for (const project of projects) {
    if (!containsDirectory(project.path, directory)) continue;
    if (!match || project.path.length > match.path.length) match = project;
  }
  return match?.id ?? null;
};

const stateOf = (session: Session, input: HostSnapshotInput): HostSessionState => {
  const pending = input.pendingBySession.get(session.id);
  if (pending && pending.permissions.length > 0) return 'waiting-permission';
  if (pending && (pending.forms.length > 0 || pending.pages.length > 0)) return 'waiting-input';
  const status = input.statusById.get(session.id)?.status.type;
  if (status === 'busy' || status === 'retry') return 'running';
  return session.outcome === 'failed' ? 'failed' : 'idle';
};

const summaryOf = (session: Session, input: HostSnapshotInput, projects: readonly HostProject[] | undefined): HostSessionSummary => {
  const summary: HostSessionSummary = {
    id: session.id,
    title: session.title,
    directory: session.directory,
    updatedAt: session.time.updated,
    state: stateOf(session, input),
    work: isSessionInWork(session) ? 'open' : null,
  };
  if (session.parentID) summary.parentID = session.parentID;
  if (session.model?.providerID) summary.providerId = session.model.providerID;
  if (session.outcome) summary.outcome = session.outcome;
  if (projects) summary.projectId = projectIdOf(session.directory, projects);
  return summary;
};

const listStatusOf = (input: HostSnapshotInput): HostSnapshot['status'] => {
  if (input.listStatus === 'error') return 'error';
  return input.hasLoaded && input.listStatus === 'ready' ? 'ready' : 'loading';
};

const sameInput = (left: HostSnapshotInput, right: HostSnapshotInput): boolean => (
  left.activeSessions === right.activeSessions
  && left.hasLoaded === right.hasLoaded
  && left.listStatus === right.listStatus
  && left.statusById === right.statusById
  && left.pendingBySession === right.pendingBySession
  && left.projects === right.projects
  && left.defaultProjectId === right.defaultProjectId
);

const sameProjects = (left: readonly HostProject[] | undefined, right: readonly HostProject[] | undefined): boolean => (
  left === right || (
    left !== undefined && right !== undefined && left.length === right.length
    && left.every((project, index) => {
      const other = right[index];
      return project.id === other.id && project.label === other.label && project.path === other.path
        && project.order === other.order && project.isDefault === other.isDefault;
    })
  )
);

export type HostSnapshotProjector = (input: HostSnapshotInput, now: number) => HostSnapshot;

export const createHostSnapshotProjector = (): HostSnapshotProjector => {
  let lastInput: HostSnapshotInput | null = null;
  let lastSnapshot: HostSnapshot | null = null;

  return (input, now) => {
    if (lastInput && lastSnapshot && sameInput(lastInput, input)) return lastSnapshot;
    const previous = lastSnapshot;
    const nextProjects = input.projects ? toHostProjects(input.projects, input.defaultProjectId) : undefined;
    const projects = previous && sameProjects(previous.projects, nextProjects) ? previous.projects : nextProjects;
    const status = listStatusOf(input);
    const previousSessions = previous?.sessions ?? EMPTY_SESSIONS;
    const sessions = new Map<string, HostSessionSummary>();
    let changed = previousSessions.size !== input.activeSessions.length;
    for (const session of input.activeSessions) {
      const next = summaryOf(session, input, projects);
      const prior = previousSessions.get(session.id);
      const kept = prior && sameSummary(prior, next) ? prior : next;
      if (kept !== prior) changed = true;
      sessions.set(session.id, kept);
    }
    const snapshot: HostSnapshot = {
      status,
      sessions: changed ? sessions : previousSessions,
      lastCompleteAt: status === 'ready' ? previous?.lastCompleteAt ?? now : previous?.lastCompleteAt ?? null,
    };
    if (projects) snapshot.projects = projects;
    const unchanged = previous !== null
      && previous.status === snapshot.status
      && previous.sessions === snapshot.sessions
      && previous.lastCompleteAt === snapshot.lastCompleteAt
      && previous.projects === snapshot.projects;
    lastInput = input;
    lastSnapshot = unchanged ? previous : snapshot;
    return lastSnapshot;
  };
};

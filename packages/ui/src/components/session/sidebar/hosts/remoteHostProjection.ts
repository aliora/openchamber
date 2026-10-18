import type { HostConnection, HostDescriptor, HostProject, HostSessionSummary, HostSnapshot, MonitoredHost } from '@/lib/hosts/types';
import { formatDirectoryName } from '@/lib/utils';
import { isAttentionState, isRunningState, resolveSessionLiveState, type SessionLiveState } from '../sessions/sessionLiveState';

// What the sidebar shows of a host the window watches but is not connected to
// (`lib/hosts`): its top-level sessions with their live state, grouped as
// Chats, then the host's projects, then one group per folder for the rest. The rows are read-only; opening one
// switches the window to the host (`lib/hosts/open-host-session.ts`).

/** One top-level session of a monitored host, as its row shows it. */
export type RemoteSessionItem = {
  host: HostDescriptor;
  session: HostSessionSummary;
  /** Ranked like a local row: a request of the session or one of its subsessions, a failed turn, a running one. */
  liveState: SessionLiveState;
  /** The folder's name; null for a chat. */
  folderLabel: string | null;
};

export type RemoteSessionGroup = {
  /** `chats`, `project:<id>`, or the folder's path. */
  id: string;
  kind: 'chats' | 'project' | 'folder';
  /** The folder; null for Chats. A project's is its path. */
  directory: string | null;
  /** The host's project; null for Chats and folders. */
  project: HostProject | null;
  sessions: readonly RemoteSessionItem[];
};

export type SidebarRemoteHost = {
  descriptor: HostDescriptor;
  connection: HostConnection;
  snapshotStatus: HostSnapshot['status'];
  lastCompleteAt: number | null;
  /** Chats first, then the host's projects (its default first), then folders by their newest session. */
  groups: readonly RemoteSessionGroup[];
  /** Every top-level session, newest first. */
  sessions: readonly RemoteSessionItem[];
};

/** Subagents nest; a deeper chain than this is not followed. */
const MAX_DEPTH = 8;

const collectDescendants = (
  rootId: string,
  childrenByParent: ReadonlyMap<string, readonly HostSessionSummary[]>,
): HostSessionSummary[] => {
  const found: HostSessionSummary[] = [];
  const seen = new Set<string>([rootId]);
  let level: readonly string[] = [rootId];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of level) {
      for (const child of childrenByParent.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        next.push(child.id);
      }
    }
    level = next;
  }
  return found;
};

/**
 * A root's state from the host's rows: a subsession's permission request or
 * question waits on the user for the whole run, as on the local host; a
 * failure counts only for the session itself. A host knows nothing about
 * what this window has seen, so a remote row is never unread.
 */
const rootLiveState = (root: HostSessionSummary, descendants: readonly HostSessionSummary[]): SessionLiveState => {
  const tree = [root, ...descendants];
  return resolveSessionLiveState({
    pendingPermission: tree.some((session) => session.state === 'waiting-permission'),
    pendingInput: tree.some((session) => session.state === 'waiting-input'),
    failedUnseen: root.state === 'failed',
    turnActivity: root.state === 'running'
      ? 'running'
      : descendants.some((session) => session.state === 'running') ? 'subagent' : null,
    unread: false,
  });
};

const newestFirst = (left: RemoteSessionItem, right: RemoteSessionItem): number => (
  right.session.updatedAt - left.session.updatedAt || left.session.id.localeCompare(right.session.id)
);

const defaultFirst = (left: HostProject, right: HostProject): number => (
  Number(right.isDefault) - Number(left.isDefault) || left.order - right.order
);

const groupByProject = (
  items: readonly RemoteSessionItem[],
  projects: readonly HostProject[],
): { groups: RemoteSessionGroup[]; rest: RemoteSessionItem[] } => {
  const byProject = new Map<string, RemoteSessionItem[]>(projects.map((project) => [project.id, []]));
  const rest: RemoteSessionItem[] = [];
  for (const item of items) {
    const list = item.session.projectId ? byProject.get(item.session.projectId) : undefined;
    if (list) list.push(item);
    else rest.push(item);
  }
  const groups = [...projects].sort(defaultFirst).flatMap((project): RemoteSessionGroup[] => {
    const sessions = byProject.get(project.id) ?? [];
    return sessions.length > 0
      ? [{ id: `project:${project.id}`, kind: 'project', directory: project.path, project, sessions }]
      : [];
  });
  return { groups, rest };
};

const projectHost = (host: MonitoredHost): SidebarRemoteHost => {
  const all = host.snapshot.sessions;
  const childrenByParent = new Map<string, HostSessionSummary[]>();
  const roots: HostSessionSummary[] = [];
  for (const session of all.values()) {
    // A subsession whose parent is not listed stays visible as a root.
    if (session.parentID && all.has(session.parentID)) {
      const siblings = childrenByParent.get(session.parentID);
      if (siblings) siblings.push(session);
      else childrenByParent.set(session.parentID, [session]);
    } else {
      roots.push(session);
    }
  }
  const sessions = roots.map((session): RemoteSessionItem => ({
    host: host.descriptor,
    session,
    liveState: rootLiveState(session, collectDescendants(session.id, childrenByParent)),
    folderLabel: session.chat ? null : formatDirectoryName(session.directory),
  })).sort(newestFirst);

  const chats = sessions.filter((item) => item.session.chat);
  const { groups, rest } = host.snapshot.projects
    ? groupByProject(sessions.filter((item) => !item.session.chat), host.snapshot.projects)
    : { groups: [], rest: sessions.filter((item) => !item.session.chat) };
  const byFolder = new Map<string, RemoteSessionItem[]>();
  for (const item of rest) {
    const list = byFolder.get(item.session.directory);
    if (list) list.push(item);
    else byFolder.set(item.session.directory, [item]);
  }
  // Sessions are newest first, so folders come in the order of their newest session.
  for (const [directory, items] of byFolder) groups.push({ id: directory, kind: 'folder', directory, project: null, sessions: items });
  if (chats.length > 0) groups.unshift({ id: 'chats', kind: 'chats', directory: null, project: null, sessions: chats });
  return {
    descriptor: host.descriptor,
    connection: host.connection,
    snapshotStatus: host.snapshot.status,
    lastCompleteAt: host.snapshot.lastCompleteAt,
    groups,
    sessions,
  };
};

// A host's entry object changes only when that host changes, so its
// projection is kept per entry and an unchanged host keeps its rows.
const projectionByHost = new WeakMap<MonitoredHost, SidebarRemoteHost>();

export const projectMonitoredHost = (host: MonitoredHost): SidebarRemoteHost => {
  const cached = projectionByHost.get(host);
  if (cached) return cached;
  const projected = projectHost(host);
  projectionByHost.set(host, projected);
  return projected;
};

/** Sessions of every monitored host that wait on the user, newest first. A failed turn is not among them: a host cannot say whether the user saw it. */
export const selectRemoteAttention = (hosts: readonly SidebarRemoteHost[]): RemoteSessionItem[] => (
  hosts.flatMap((host) => host.sessions.filter((item) => isAttentionState(item.liveState) && item.liveState !== 'failed'))
    .sort(newestFirst)
);

/** Sessions of every monitored host with a turn running now, newest first. */
export const selectRemoteRunning = (hosts: readonly SidebarRemoteHost[]): RemoteSessionItem[] => (
  hosts.flatMap((host) => host.sessions.filter((item) => isRunningState(item.liveState))).sort(newestFirst)
);

/**
 * Whether a remote session matches a sidebar search: a `ses_` query matches
 * the exact id only, anything else the title, like local rows.
 */
export const remoteSessionMatchesQuery = (item: RemoteSessionItem, normalizedQuery: string): boolean => {
  const query = normalizedQuery.trim().toLowerCase();
  if (!query) return true;
  if (query.startsWith('ses_')) return item.session.id.toLowerCase() === query;
  return item.session.title.toLowerCase().includes(query);
};

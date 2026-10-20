import type { HostConnection, HostDescriptor, HostProject, HostSessionSummary, HostSnapshot, MonitoredHost } from '@/lib/hosts/types';
import { formatDirectoryName } from '@/lib/utils';
import { isAttentionState, isRunningState, resolveSessionLiveState, type SessionLiveState } from '../sessions/sessionLiveState';

// What the sidebar shows of a host the window runs beside the focused one
// (`lib/hosts`): its top-level sessions with their live state and their
// subsessions nested under them. Opening one moves the focus to the host
// (`lib/hosts/open-host-session.ts`).

export type RemoteSessionItem = {
  host: HostDescriptor;
  session: HostSessionSummary;
  /** Ranked like a local row: a request of the session or one of its subsessions, a failed turn, a running one. */
  liveState: SessionLiveState;
  /** The folder's name; null for a chat. */
  folderLabel: string | null;
  projectChip: string | null;
  children: readonly RemoteSessionItem[];
};

export type SidebarRemoteHost = {
  descriptor: HostDescriptor;
  connection: HostConnection;
  snapshotStatus: HostSnapshot['status'];
  lastCompleteAt: number | null;
  /** Every top-level session, newest first. */
  sessions: readonly RemoteSessionItem[];
  newSessionDirectory: string | null;
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

export const hostProjectOrder = (left: HostProject, right: HostProject): number => (
  Number(right.isDefault) - Number(left.isDefault) || left.order - right.order
);

const placeKey = (session: HostSessionSummary): string => (
  session.projectId ? `project:${session.projectId}` : `folder:${session.directory}`
);

const resolveMainPlace = (
  roots: readonly HostSessionSummary[],
  projects: readonly HostProject[] | undefined,
): { key: string; directory: string } | null => {
  const [mainProject] = [...(projects ?? [])].sort(hostProjectOrder);
  if (mainProject) return { key: `project:${mainProject.id}`, directory: mainProject.path };
  const countByPlace = new Map<string, number>();
  let best: HostSessionSummary | null = null;
  for (const session of roots) {
    if (session.chat) continue;
    const count = (countByPlace.get(placeKey(session)) ?? 0) + 1;
    countByPlace.set(placeKey(session), count);
    if (!best || count > (countByPlace.get(placeKey(best)) ?? 0)) best = session;
  }
  return best ? { key: placeKey(best), directory: best.directory } : null;
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
  const projectLabelById = new Map((host.snapshot.projects ?? []).map((project) => [project.id, project.label]));
  const mainPlace = resolveMainPlace([...roots].sort((left, right) => right.updatedAt - left.updatedAt), host.snapshot.projects);
  const placed = new Set<string>();
  const toItem = (session: HostSessionSummary, depth: number): RemoteSessionItem => {
    placed.add(session.id);
    const folderLabel = session.chat ? null : formatDirectoryName(session.directory);
    const outsideMain = depth === 0 && !session.chat && placeKey(session) !== mainPlace?.key;
    const children = depth < MAX_DEPTH
      ? (childrenByParent.get(session.id) ?? []).filter((child) => !placed.has(child.id)).map((child) => toItem(child, depth + 1)).sort(newestFirst)
      : [];
    return {
      host: host.descriptor,
      session,
      liveState: rootLiveState(session, collectDescendants(session.id, childrenByParent)),
      folderLabel,
      projectChip: outsideMain ? projectLabelById.get(session.projectId ?? '') ?? folderLabel : null,
      children,
    };
  };
  return {
    descriptor: host.descriptor,
    connection: host.connection,
    snapshotStatus: host.snapshot.status,
    lastCompleteAt: host.snapshot.lastCompleteAt,
    sessions: roots.map((session) => toItem(session, 0)).sort(newestFirst),
    newSessionDirectory: mainPlace?.directory ?? null,
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

const waitsOnUser = (item: RemoteSessionItem): boolean => isAttentionState(item.liveState) && item.liveState !== 'failed';

/** Sessions of every monitored host that wait on the user, newest first. A failed turn is not among them: a host cannot say whether the user saw it. */
export const selectRemoteAttention = (hosts: readonly SidebarRemoteHost[]): RemoteSessionItem[] => (
  hosts.flatMap((host) => host.sessions.filter(waitsOnUser)).sort(newestFirst)
);

/** Sessions of every monitored host with a turn running now, newest first. */
export const selectRemoteRunning = (hosts: readonly SidebarRemoteHost[]): RemoteSessionItem[] => (
  hosts.flatMap((host) => host.sessions.filter((item) => isRunningState(item.liveState))).sort(newestFirst)
);

export const selectRemoteWork = (hosts: readonly SidebarRemoteHost[]): RemoteSessionItem[] => (
  hosts.flatMap((host) => host.sessions.filter((item) => (
    item.session.work === 'open' && !item.session.chat && !waitsOnUser(item)
  ))).sort(newestFirst)
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

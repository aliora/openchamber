import type { Session } from '@/lib/opencode/model';
import type { SessionFolder, SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import { isSessionPinned } from '@/lib/sessionPins';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildGroupRenderDescriptors } from './projects/sessionProjectRender';
import { normalizeFolderRoots, selectFolderIdsForProjection, selectFolderRootNodes, type BlockingBadgeSessionScope } from './sessions/sessionNodeItemUtils';
import { getSessionFolderIdentityKey, getSessionFolderOwnerKey, getSessionFolderScopes, isArchivedFolderScope } from './sessions/sessionFolderIdentity';
import type { SessionRowOrderEntry } from './sessions/sessionRowOrder';
import { computeSessionTreeGuides, type SessionTreeGuide } from './sessions/sessionTreeGeometry';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { EMPTY_MULTI_RUN_INDEX, type MultiRunIndex, type MultiRunSummary } from '@/lib/multirun/runs';
import { isGroupWork, worktreeFolderMemberId } from './works/sidebarWorks';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import type { HostDescriptor } from '@/lib/hosts/types';
import {
  isRemoteScheduledRun,
  remoteSessionMatchesQuery,
  selectRemoteAttention,
  selectRemoteRunning,
  selectRemoteScheduled,
  type RemoteSessionItem,
  type SidebarRemoteHost,
} from './hosts/remoteHostProjection';
import {
  HOST_SESSION_INITIAL_COUNT,
  hostSessionListKey,
  selectHostSessionPage,
  sortHostSessionEntries,
  type HostSessionEntry,
} from './hosts/hostSessionList';
import { isAttentionState, isRunningState } from './sessions/sessionLiveState';
import type { SessionSortOrder } from '@/stores/useSessionDisplayStore';
import { sessionStatusRank, sortSessionsBy, type SortableSession } from './sessionSort';

export type SessionSidebarActivityItem = {
  node: SessionNode;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null; projectChip?: string | null; inSpace?: boolean } | null;
  getSecondaryMeta?: (sessionId: string) => SessionSidebarActivityItem['secondaryMeta'];
  /** Search matches in the session's whole tree, for zone rows whose node drops its children. */
  searchMatchCount?: number;
};

/**
 * One entry of the In work block or of the list by time: a session work's
 * row (the session with what grew out of it nested under it), or a worktree
 * work, drawn as its group row with its sessions under it.
 */
export type SessionSidebarWorkEntry =
  | { kind: 'session'; item: SessionSidebarActivityItem }
  | { kind: 'group'; groupKey: string; projectId: string; group: SessionGroup }
  // A project root's draft, in the list by time; a worktree's drafts sit in its group.
  | { kind: 'draft'; draft: SessionDraft; projectId: string };

/**
 * Zones above the projects. `attention` ("Needs you") lists sessions waiting
 * on the user or with a failed turn nobody has seen; `running` is what the
 * Running filter shows; 'timeline' is the one list of every project's works
 * when the sidebar groups them by time. The host level (one header per
 * OpenChamber host above its zones and projects) is a row kind of its own, so
 * zones stay keyed the same under it.
 */
export type SessionSidebarActivityKey = 'attention' | 'running' | 'pinned' | 'work' | 'chats' | 'scheduled' | 'timeline';

/**
 * Activity sections; the display menu's Collapse all / Expand all drive them
 * with the projects. "Needs you" is left out: it lists what is waiting on the
 * user, so tidying the list must not hide it.
 */
export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = ['chats', 'pinned', 'work', 'scheduled', 'timeline'];

/**
 * What the header's status filter shows: everything, only the "Needs you"
 * zone, or only the sessions running now.
 */
export type SessionSidebarStatusFilter = 'all' | 'attention' | 'running';

// 'project' is a one-line file tree row under a project. Rows of zones that
// mix projects (Pinned, In work, the list by time) are 'mixed-compact', one
// line, or with detailed rows 'timeline-mixed', two lines, the project's icon
// opening the second. 'tree-chat' is a Chats row. Every one keeps the tree's
// slot left of the title, which shows the live state or the chevron.
export type SessionSidebarRenderContext = 'project' | 'timeline-mixed' | 'mixed-compact' | 'tree-chat';

/** Rows that render through `SessionTimelineRowBody` with two lines. */
export const isMultiLineTimelineContext = (context: SessionSidebarRenderContext): boolean => context === 'timeline-mixed';

export type SessionSidebarGroupStatus = {
  state: 'ready' | 'loading' | 'load-failed' | 'initialization-failed' | 'permission-denied';
  directory: string | null;
  canGrantAccess: boolean;
};

export type SessionSidebarOwnerAuthority = {
  scopeKeys: readonly string[];
  complete: boolean;
};

/**
 * The hosts shown when the window watches other OpenChamber hosts: the one
 * the window is on, with today's zones and projects, then each watched host
 * with its sessions. Absent with a single host, which shows no host header.
 */
export type SessionSidebarHosts = {
  /** The saved host the window is on; null when its address matches none. */
  active: HostDescriptor | null;
  /** The window's runtime key, which keys the active host's collapse. */
  activeRuntimeKey: string;
  activeSessions: readonly HostSessionEntry<SessionSidebarActivityItem>[];
  activeNewSession: SessionSidebarHostNewSession | null;
  monitored: readonly SidebarRemoteHost[];
  /** Other hosts' pinned sessions; empty while the Pinned zone is hidden. */
  pinned: readonly RemoteSessionItem[];
  work: readonly RemoteSessionItem[];
  attention: readonly RemoteSessionItem[];
  order: readonly string[];
  sort: SessionSortOrder;
  /** Collapsed hosts, by runtime key. */
  collapsed: ReadonlySet<string>;
};

export type SessionSidebarHostNewSession = { projectId: string | null; directory: string };

/** What a host header names: the host the window is on, or a watched one. */
export type SessionSidebarHostHeader =
  | { kind: 'active'; descriptor: HostDescriptor | null }
  | { kind: 'monitored'; host: SidebarRemoteHost };

// `treeGuides`: the guide lines a Tree row draws over itself, framing the
// children of an open worktree, folder, session or run.
type RowBase = { key: string; estimateSize: number; treeGuides?: readonly SessionTreeGuide[] };

export type SessionSidebarRow =
  // `count`: how many sessions the zone holds, shown beside "Needs you" so a
  // collapsed zone still says that something waits.
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; forceExpanded: boolean; count?: number })
  | (RowBase & { kind: 'project-header'; section: ProjectSection; collapsed: boolean; forceExpanded: boolean })
  // `empty`: nothing to list under the header, so it offers no chevron.
  // `depth`: its tree level (1 inside a folder). `mixed`: listed among other
  // projects' works (In work, the list by time), so it names its project.
  // `detailed`: such a worktree work drawn in two lines, as the detailed zone
  // rows around it are.
  | (RowBase & { kind: 'group-header'; group: SessionGroup; groupKey: string; projectId: string | null; collapsed: boolean; forceExpanded: boolean; empty: boolean; allSessions: readonly Session[]; depth: number; mixed: boolean; detailed: boolean })
  | (RowBase & { kind: 'folder-header'; depth: number; group: SessionGroup; folder: SessionFolder; displayName: string; scopeKey: string; scopeDirectory: string | null; ownerKey: string | null; nodes: readonly SessionNode[]; activityNodes: readonly SessionNode[]; projectId: string | null; archived: boolean; collapsed: boolean; forceExpanded: boolean; empty: boolean; deleteSessions: readonly Session[]; subFolderCount: number; dropEnabled: boolean })
  // `ownsWork`: the row is a work of its own, so it offers Track / Done.
  // What nests under a session, a lane of a run and a session of a worktree
  // work belong to the work above them, which tracks and finishes them all.
  | (RowBase & { kind: 'session'; node: SessionNode; blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[]; depth: number; ownsWork: boolean; projectId: string | null; groupDirectory: string | null; ownerKey: string | null; selectionScopeKey: string | null; archived: boolean; renderContext: SessionSidebarRenderContext; secondaryMeta: SessionSidebarActivityItem['secondaryMeta']; detailed?: boolean; expanded?: boolean; forceExpanded?: boolean })
  // A multi-run: one derived parent row over its member sessions. It is not a
  // session, so it never enters selection, and its lanes render as session
  // rows one level deeper when it is expanded.
  // A new session's draft the user left before sending, where its session
  // would go. `mixed`: in a zone, so it names its project. `detailed`: two
  // lines, as a work of its own is with Detailed rows on.
  | (RowBase & { kind: 'draft'; draft: SessionDraft; depth: number; projectId: string | null; mixed: boolean; detailed: boolean })
  | (RowBase & { kind: 'run'; run: MultiRunSummary; depth: number; laneNodes: readonly SessionNode[]; blockingSessionIds: readonly string[]; projectId: string | null; projectLabel: string | null; groupDirectory: string | null; renderContext: SessionSidebarRenderContext; expansionKey: string; expanded: boolean; forceExpanded: boolean; detailed: boolean })
  // The rows below line up with the text of the rows they close: `flat` with
  // gutterless timeline-style rows, otherwise with the tree level `depth`.
  | (RowBase & { kind: 'empty'; emptyKind: 'sidebar' | 'search' | 'archived' | 'attention-filter' | 'running-filter'; depth?: number })
  | (RowBase & { kind: 'status'; status: SessionSidebarGroupStatus; group: SessionGroup; groupKey: string; depth?: number; flat?: boolean })
  | (RowBase & { kind: 'show-control'; control: 'more' | 'fewer'; containerKey: string; depth?: number; flat?: boolean })
  // A host header; `runtimeKey` keys its collapse.
  | (RowBase & { kind: 'host-header'; runtimeKey: string; header: SessionSidebarHostHeader; collapsed: boolean; forceExpanded: boolean; newSession: SessionSidebarHostNewSession | null })
  // Under a watched host's header when its list is not current or not there:
  // why (offline, sign in, update, relay limit), loading, or no sessions.
  | (RowBase & { kind: 'host-status'; host: SidebarRemoteHost })
  // A session of a watched host: read-only, opened by switching to the host.
  // 'tree' under its host; 'timeline-mixed' in a status filter, naming its host.
  // `dimmed`: the list may be out of date.
  | (RowBase & { kind: 'remote-session'; item: RemoteSessionItem; renderContext: 'tree' | 'timeline-mixed'; dimmed: boolean; depth: number; expansionKey: string; expanded: boolean });

export type SessionSidebarStickyHeader = {
  rowIndex: number;
  kind: 'activity' | 'project' | 'host';
  id: string;
};

export type SessionSidebarFolderTarget = {
  rowKey: string;
  scopeKey: string;
  folderId: string;
  ownerKey: string;
  enabled: boolean;
};

export type SessionSidebarRowModel = {
  rows: readonly SessionSidebarRow[];
  selectionEntries: readonly SessionRowOrderEntry[];
  selectionDescendantIds: readonly string[];
  rowIndexByKey: ReadonlyMap<string, number>;
  stickyHeaders: readonly SessionSidebarStickyHeader[];
  folderDropTargets: readonly SessionSidebarFolderTarget[];
  folderAuthorityByOwner: ReadonlyMap<string, SessionSidebarOwnerAuthority>;
  sessionById: ReadonlyMap<string, Session>;
  searchMatchCount: number;
};

export type SessionSidebarRowModelArgs = {
  mode: 'normal' | 'search';
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  /** Pinned sessions, already ordered and search-filtered; they stay under their project too. */
  pinnedItems?: readonly SessionSidebarActivityItem[];
  /** Pinned worktree works, listed after the pinned sessions, the latest pin first; they leave their project. */
  pinnedWorktrees?: readonly SessionSidebarWorkEntry[];
  /** The works in the In work block, in lifecycle order. */
  workEntries?: readonly SessionSidebarWorkEntry[];
  /**
   * Set when the sidebar groups by time: every other work of every project,
   * in one list under one zone header, in place of the project headers.
   */
  timeEntries?: readonly SessionSidebarWorkEntry[] | null;
  /** Drafts of new sessions by the group their session would go to, newest first. */
  draftsByGroupKey?: ReadonlyMap<string, readonly SessionDraft[]>;
  /** Root sessions and worktree groups of the works In work lists, left out of their project. */
  movedSessionIds?: ReadonlySet<string>;
  movedGroupKeys?: ReadonlySet<string>;
  /**
   * "Needs you": sessions waiting on a permission or an answer, or whose
   * latest turn failed unseen, already ordered and search-filtered. Listed
   * above everything else; the sessions stay in their zones and projects too.
   */
  attentionItems?: readonly SessionSidebarActivityItem[];
  /** Sessions running now, for the Running filter. */
  runningItems?: readonly SessionSidebarActivityItem[];
  scheduledItems?: readonly SessionSidebarActivityItem[];
  /** The session sort for this host's own zones; they keep the lifecycle order when absent. */
  sessionSort?: SessionSortOrder;
  /** The header's status filter; `all` when absent. */
  statusFilter?: SessionSidebarStatusFilter;
  /** Every session listed in the Needs you, Pinned or In work zone, which search lists there only. */
  zoneSessionIds?: ReadonlySet<string>;
  /**
   * Detailed rows: works take two lines when set, one otherwise. That is every
   * row of the zones that mix projects (Pinned, In work, the list by time) and,
   * under a project, its works: the root's sessions and drafts and its
   * worktrees. What nests inside a work stays one line.
   */
  detailedZoneRows?: boolean;
  /** Scheduled runs sit in their own zone (the default); off, remote hosts list them with their other sessions. */
  groupScheduled?: boolean;
  foldersMap: SessionFoldersMap;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  normalizedQuery: string;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  collapsedFolders: ReadonlySet<string>;
  collapsedActivities: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  visibleCountByContainer: ReadonlyMap<string, number>;
  pinnedSessionIds: ReadonlySet<string>;
  sessionOrderIndex: ReadonlyMap<string, number>;
  /**
   * The place in `sessionOrderIndex` a worktree work's archived sessions hold
   * it at, by group key (`buildWorktreeArchiveAnchors`).
   */
  worktreeArchiveAnchors?: ReadonlyMap<string, number>;
  /**
   * The spaces being made or running, by id: one of them that nobody has
   * chatted in yet leads its project's list (`mergeWorktreeEntries`).
   */
  liveSpaceIds?: ReadonlySet<string>;
  groupStatusByKey: ReadonlyMap<string, SessionSidebarGroupStatus>;
  folderAuthorityByOwner: ReadonlyMap<string, SessionSidebarOwnerAuthority>;
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hideDirectoryControls: boolean;
  currentSessionId?: string | null;
  /** Active multi-runs; their member sessions collapse into one run row per container. */
  runIndex?: MultiRunIndex;
  /** Set when the window watches other hosts: host headers, their sessions, and theirs in the zones. */
  hosts?: SessionSidebarHosts;
};

type RunEntry = { run: MultiRunSummary; lanes: SessionNode[] };
type SidebarEntry = SessionNode | RunEntry;

const isRunEntry = (entry: SidebarEntry): entry is RunEntry => 'run' in entry;

const isRemoteWaiting = (item: RemoteSessionItem): boolean => isAttentionState(item.liveState) && item.liveState !== 'failed';

const remoteExpansionKey = (item: RemoteSessionItem): string => `remote:${item.host.runtimeKey}:${item.session.id}`;

/**
 * The `expandedParents` key of a session row: per render context, so the same
 * session listed in a project and in In work opens in one place only.
 */
export const sessionExpansionKey = (renderContext: SessionSidebarRenderContext, archived: boolean, sessionId: string): string => (
  `${renderContext}:${archived ? 'archived' : 'active'}:${sessionId}`
);

export const runExpansionKey = (renderContext: SessionSidebarRenderContext, runKey: string): string => (
  `${renderContext}:active:run:${runKey}`
);

/**
 * Replaces the member sessions of each run with one entry at the position of
 * its first member (entries arrive in display order). Archived lists never
 * collapse: archived sessions are not run members.
 */
const collapseRunEntries = (nodes: readonly SessionNode[], runIndex: MultiRunIndex, archived: boolean): SidebarEntry[] => {
  if (archived || runIndex.runKeyBySessionId.size === 0) return [...nodes];
  const entries: SidebarEntry[] = [];
  const byRun = new Map<string, RunEntry>();
  for (const node of nodes) {
    const runKey = runIndex.runKeyBySessionId.get(node.session.id);
    const run = runKey ? runIndex.runs.get(runKey) : undefined;
    if (!run) {
      entries.push(node);
      continue;
    }
    const existing = byRun.get(run.key);
    if (existing) {
      existing.lanes.push(node);
      continue;
    }
    const entry: RunEntry = { run, lanes: [node] };
    byRun.set(run.key, entry);
    entries.push(entry);
  }
  for (const entry of byRun.values()) {
    const order = new Map(entry.run.memberIds.map((id, index) => [id, index]));
    entry.lanes.sort((left, right) => (order.get(left.session.id) ?? 0) - (order.get(right.session.id) ?? 0));
  }
  return entries;
};

/**
 * How many sessions of search-filtered trees a group reports as matches: for
 * a `ses_` id query the exact id only, otherwise every session the search
 * kept. Group search data and the row model both count with this, so taking
 * trees out of a group takes exactly their share out of its count.
 */
export const countSessionSearchMatches = (nodes: readonly SessionNode[], normalizedQuery: string): number => {
  const idQuery = normalizedQuery.trim().toLowerCase();
  const isIdQuery = idQuery.startsWith('ses_');
  const count = (list: readonly SessionNode[]): number => list.reduce((total, node) => (
    total + (!isIdQuery || node.session.id.toLowerCase() === idQuery ? 1 : 0) + count(node.children)
  ), 0);
  return count(nodes);
};

const EMPTY_FOLDERS: readonly SessionFolder[] = [];
const EMPTY_ZONE_SESSION_IDS: ReadonlySet<string> = new Set();
const EMPTY_DRAFTS: readonly SessionDraft[] = [];
const EMPTY_ARCHIVE_ANCHORS: ReadonlyMap<string, number> = new Map();
const EMPTY_SPACE_IDS: ReadonlySet<string> = new Set();
// One line: the 20px line, 6px above and below, and the 1px margin each side
// the row renderer gives session rows (`my-px`).
const SESSION_ESTIMATE = 34;
const TIMELINE_SESSION_ESTIMATE = 52;
const estimateSessionRow = (context: SessionSidebarRenderContext): number => (
  isMultiLineTimelineContext(context) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE
);
// Chats open on a short page, with pinned chats on top of it.
const CHATS_INITIAL_LIMIT = 3;
// "Needs you" shows its first few above the list; the filter shows them all.
const ATTENTION_INITIAL_LIMIT = 5;
// Project and worktree lists open on 3 sessions and reveal the rest on Show more.
const SESSIONS_INITIAL_LIMIT = 3;
const SCHEDULED_INITIAL_LIMIT = 3;

const HEADER_ESTIMATE = 32;
// Zone and project headers: their label is a size up from rows (`typography-ui-section`).
const SECTION_HEADER_ESTIMATE = 34;
const STATUS_ESTIMATE = 28;

/**
 * A row's level in the drawn tree, or null for a row outside it: headers of
 * projects and zones, Show more and status lines.
 * Worktree, space and archive headers open the tree at level 0.
 */
const treeLevelOf = (row: SessionSidebarRow): number | null => {
  switch (row.kind) {
    case 'group-header': return row.depth;
    case 'folder-header': return row.depth;
    case 'draft': return row.depth;
    case 'session':
    case 'run': return row.depth;
    default: return null;
  }
};

const compareNodes = (
  left: SessionNode,
  right: SessionNode,
  pinnedSessionIds: Set<string>,
  sessionOrderIndex: ReadonlyMap<string, number>,
): number => {
  const leftIndex = sessionOrderIndex.get(left.session.id);
  const rightIndex = sessionOrderIndex.get(right.session.id);
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return compareSessionsByLifecycleOrder(left.session, right.session, pinnedSessionIds, EMPTY_SESSION_ORDER_RANKS);
};

/**
 * The project root's entries with its worktree and space works merged in,
 * each work at the place of its most recent session, archived ones included,
 * so a worktree someone just worked in leads the list as a session there
 * would and archiving a session does not move it. A worktree that never had a
 * session closes it; a space that never had one leads it.
 */
const mergeWorktreeEntries = (
  entries: readonly SidebarEntry[],
  worktrees: readonly WorktreeInFolder[],
  sessionOrderIndex: ReadonlyMap<string, number>,
  archiveAnchors: ReadonlyMap<string, number>,
  liveSpaceIds: ReadonlySet<string>,
): ListedEntry[] => {
  if (worktrees.length === 0) return [...entries];
  const rankOfNode = (node: SessionNode): number => sessionOrderIndex.get(node.session.id) ?? Number.POSITIVE_INFINITY;
  const rankOfEntry = (entry: SidebarEntry): number => (isRunEntry(entry) ? Math.min(...entry.lanes.map(rankOfNode)) : rankOfNode(entry));
  const rankOfWorktree = ({ group, groupKey }: WorktreeInFolder): number => {
    // A pinned worktree still listed here (the Pinned section is hidden)
    // leads the list, as pinned sessions do.
    if (group.worktree?.pinnedAt !== undefined) return Number.NEGATIVE_INFINITY;
    // A space nobody has chatted in yet, being made or running, was made to be used now: it leads
    // the list, where a worktree without sessions closes it, so it is never hidden under Show
    // more. One whose making failed or whose container is gone closes the list like that worktree.
    if (group.space && liveSpaceIds.has(group.space.id) && group.sessions.length === 0 && !archiveAnchors.has(groupKey)) return Number.NEGATIVE_INFINITY;
    let best = archiveAnchors.get(groupKey) ?? Number.POSITIVE_INFINITY;
    const stack = [...group.sessions];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      best = Math.min(best, rankOfNode(node));
      stack.push(...node.children);
    }
    return best;
  };
  const ranked = worktrees
    .map((worktree) => ({ worktree, rank: rankOfWorktree(worktree) }))
    .sort((left, right) => left.rank - right.rank);
  const merged: ListedEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    const rank = rankOfEntry(entry);
    while (next < ranked.length && (ranked[next]?.rank ?? 0) < rank) {
      const item = ranked[next];
      if (item) merged.push({ listedWorktree: item.worktree });
      next += 1;
    }
    merged.push(entry);
  }
  for (; next < ranked.length; next += 1) {
    const item = ranked[next];
    if (item) merged.push({ listedWorktree: item.worktree });
  }
  return merged;
};

type FolderProjection = {
  folder: SessionFolder;
  scopeKey: string;
  scopeDirectory: string | null;
  ownerKey: string | null;
  nodes: readonly SessionNode[];
};

type IndexedSessionNodes = {
  byId: ReadonlyMap<string, SessionNode>;
  sessionsById: ReadonlyMap<string, Session>;
  preorderIds: readonly string[];
  subtreeRangeByNode: WeakMap<SessionNode, readonly [start: number, end: number]>;
};

const indexNodes = (roots: readonly SessionNode[]): IndexedSessionNodes => {
  const byId = new Map<string, SessionNode>();
  const sessionsById = new Map<string, Session>();
  const preorderIds: string[] = [];
  const subtreeRangeByNode = new WeakMap<SessionNode, readonly [start: number, end: number]>();
  const stack: Array<{ node: SessionNode; visited: boolean }> = roots.map((node) => ({ node, visited: false })).reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    if (!entry.visited) {
      byId.set(entry.node.session.id, entry.node);
      sessionsById.set(entry.node.session.id, entry.node.session);
      const start = preorderIds.length;
      preorderIds.push(entry.node.session.id);
      subtreeRangeByNode.set(entry.node, [start, start + 1]);
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
        const child = entry.node.children[index];
        if (child) stack.push({ node: child, visited: false });
      }
      continue;
    }
    const current = subtreeRangeByNode.get(entry.node);
    if (current) subtreeRangeByNode.set(entry.node, Object.freeze([current[0], preorderIds.length]));
  }
  return { byId, sessionsById, preorderIds: Object.freeze(preorderIds), subtreeRangeByNode };
};

const expandedKey = (renderContext: SessionSidebarRenderContext, archived: boolean, id: string): string => (
  `${renderContext}:${archived ? 'archived' : 'active'}:${id}`
);

export const resolveSessionSidebarStickyHeader = (
  stickyHeaders: readonly SessionSidebarStickyHeader[],
  firstVisibleIndex: number,
): SessionSidebarStickyHeader | null => {
  let result: SessionSidebarStickyHeader | null = null;
  for (const descriptor of stickyHeaders) {
    if (descriptor.rowIndex > firstVisibleIndex) break;
    result = descriptor;
  }
  return result;
};

/** A worktree work the user filed into one of its project's folders. */
type WorktreeInFolder = { group: SessionGroup; groupKey: string };
// A worktree work listed among the project root's works, as one entry of its list.
type WorktreeEntry = { listedWorktree: WorktreeInFolder };
type ListedEntry = SidebarEntry | WorktreeEntry;
const isWorktreeEntry = (entry: ListedEntry): entry is WorktreeEntry => 'listedWorktree' in entry;

/** Where a group's rows go: under its project, in a zone, or inside a folder. */
type GroupPlacement = { keyPrefix: string; depth: number; mixed: boolean };
const PROJECT_PLACEMENT: GroupPlacement = { keyPrefix: '', depth: 0, mixed: false };

export const buildSessionSidebarRowModel = (args: SessionSidebarRowModelArgs): SessionSidebarRowModel => {
  const rows: SessionSidebarRow[] = [];
  const selectionEntries: SessionRowOrderEntry[] = [];
  const selectionDescendantIds: string[] = [];
  const stickyHeaders: SessionSidebarStickyHeader[] = [];
  const folderDropTargets: SessionSidebarFolderTarget[] = [];
  const sessionById = new Map<string, Session>();
  const keyOccurrences = new Map<string, number>();
  const search = args.mode === 'search';
  const pinned = args.pinnedSessionIds instanceof Set ? args.pinnedSessionIds : new Set(args.pinnedSessionIds);
  const inZone = args.zoneSessionIds ?? EMPTY_ZONE_SESSION_IDS;
  const movedSessionIds = args.movedSessionIds ?? EMPTY_ZONE_SESSION_IDS;
  const movedGroupKeys = args.movedGroupKeys ?? EMPTY_ZONE_SESSION_IDS;
  const scheduledItems = args.scheduledItems ?? [];
  const groupScheduled = args.groupScheduled ?? true;
  const scheduledIds = new Set(scheduledItems.map((item) => item.node.session.id));
  const sortZoneItems = (items: readonly SessionSidebarActivityItem[]): readonly SessionSidebarActivityItem[] => {
    if (!args.sessionSort) return items;
    const attentionIds = new Set((args.attentionItems ?? []).map((item) => item.node.session.id));
    const runningIds = new Set((args.runningItems ?? []).map((item) => item.node.session.id));
    return sortSessionsBy(items, args.sessionSort, (item): SortableSession => {
      const { session } = item.node;
      return {
        id: session.id,
        title: session.title ?? '',
        createdAt: session.time?.created ?? 0,
        updatedAt: session.time?.updated ?? 0,
        hostRank: 0,
        statusRank: sessionStatusRank({ waiting: attentionIds.has(session.id), running: runningIds.has(session.id) }),
        pinned: isSessionPinned(pinned, session.directory ?? item.groupDirectory, session.id),
      };
    });
  };
  // The session works of a zone in the chosen session sort; worktree works
  // and drafts keep their places.
  const sortZoneEntries = (entries: readonly SessionSidebarWorkEntry[]): readonly SessionSidebarWorkEntry[] => {
    if (!args.sessionSort) return entries;
    const sorted = sortZoneItems(entries.flatMap((entry) => entry.kind === 'session' ? [entry.item] : []));
    let next = 0;
    return entries.map((entry): SessionSidebarWorkEntry => {
      if (entry.kind !== 'session') return entry;
      const item = sorted[next];
      next += 1;
      return item ? { kind: 'session', item } : entry;
    });
  };
  // A work In work lists leaves its project, unless the user keeps it there
  // too (the collection then passes no moved sets). A scheduled run leaves it
  // for its own zone. Search lists every zone session once, in its zone, so
  // its count and rows agree.
  const isMovedToZone = (sessionId: string): boolean => movedSessionIds.has(sessionId) || (search && inZone.has(sessionId)) || scheduledIds.has(sessionId);
  let searchMatchCount = 0;

  const authoritativeRoots = [
    ...args.authoritativeSections.flatMap((section) => section.groups.flatMap((group) => group.sessions)),
    ...(args.chatGroup?.sessions ?? []),
  ];
  const authorityStack = [...authoritativeRoots];
  while (authorityStack.length > 0) {
    const node = authorityStack.pop();
    if (!node) continue;
    sessionById.set(node.session.id, node.session);
    authorityStack.push(...node.children);
  }

  const keyFor = (base: string): string => {
    const occurrence = keyOccurrences.get(base) ?? 0;
    keyOccurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  };
  const push = (row: SessionSidebarRow): void => {
    rows.push(Object.freeze(row));
  };
  const finishModel = (): SessionSidebarRowModel => {
    const guides = computeSessionTreeGuides(rows.map(treeLevelOf));
    guides.forEach((treeGuides, index) => {
      const row = rows[index];
      if (treeGuides && row) rows[index] = Object.freeze({ ...row, treeGuides });
    });
    const rowIndexByKey = new Map<string, number>();
    rows.forEach((row, index) => rowIndexByKey.set(row.key, index));
    return Object.freeze({
      rows: Object.freeze(rows),
      selectionEntries: Object.freeze(selectionEntries),
      selectionDescendantIds: Object.freeze(selectionDescendantIds),
      rowIndexByKey,
      stickyHeaders: Object.freeze(stickyHeaders),
      folderDropTargets: Object.freeze(folderDropTargets),
      folderAuthorityByOwner: args.folderAuthorityByOwner,
      sessionById,
      searchMatchCount: search ? searchMatchCount : 0,
    });
  };
  type AppendOptions = {
    nodes: readonly SessionNode[];
    blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
    containerKey: string;
    projectId: string | null;
    groupDirectory: string | null;
    ownerKey: string | null;
    selectionScopeKey: string | null;
    archived: boolean;
    renderContext: SessionSidebarRenderContext;
    secondaryMeta?: SessionSidebarActivityItem['secondaryMeta'];
    getSecondaryMeta?: SessionSidebarActivityItem['getSecondaryMeta'];
    // Per-row badge scopes for containers whose top rows come from different
    // activity items, such as the lanes of a multi-run.
    getBlockingBadgeSessionScopes?: (sessionId: string) => readonly BlockingBadgeSessionScope[] | undefined;
    indexedNodes?: IndexedSessionNodes;
    selectionPoolOffset?: number;
    // Two lines for the container's top rows, which are works of their own
    // (the project root's sessions with Detailed rows on); what nests under
    // them stays one line.
    detailedRoots?: boolean;
    // Nesting level of the container's top rows: 1 inside a folder, so its
    // sessions indent under the folder header like subagent children do.
    baseDepth?: number;
    // The container's top rows belong to a work above them (a worktree work,
    // a run), so none of the rows is a work of its own.
    insideWork?: boolean;
  };
  const runIndex = args.runIndex ?? EMPTY_MULTI_RUN_INDEX;
  const appendRun = (entry: RunEntry, options: AppendOptions): void => {
    const expansionKey = runExpansionKey(options.renderContext, entry.run.key);
    // A run opens to its lanes wherever it is listed, as any work does.
    const expanded = search || args.expandedParents.has(expansionKey);
    // Two lines where the works around it take them; its lanes stay one line.
    const detailed = options.renderContext === 'timeline-mixed' || options.detailedRoots === true;
    const firstLaneId = entry.lanes[0]?.session.id;
    const meta = firstLaneId && options.getSecondaryMeta ? options.getSecondaryMeta(firstLaneId) : options.secondaryMeta;
    // Activity lanes come without their subagent rows, so the sessions whose
    // requests block a lane (the lane and its hidden subagents) ride along for
    // the run row's badge.
    const blockingSessionIds = Object.freeze([...new Set(entry.lanes.flatMap((lane) => (
      options.getBlockingBadgeSessionScopes?.(lane.session.id) ?? []
    ).flatMap((scope) => scope.sessionIDs)))]);
    push({
      kind: 'run',
      key: keyFor(`${options.containerKey}:run:${entry.run.key}`),
      estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : estimateSessionRow(options.renderContext),
      detailed,
      run: entry.run,
      depth: options.baseDepth ?? 0,
      laneNodes: Object.freeze([...entry.lanes]),
      blockingSessionIds,
      projectId: options.projectId,
      projectLabel: meta?.projectLabel ?? null,
      groupDirectory: options.groupDirectory,
      renderContext: options.renderContext,
      expansionKey,
      expanded,
      forceExpanded: search,
    });
    if (!expanded) return;
    appendTrees(entry.lanes, (options.baseDepth ?? 0) + 1, {
      ...options,
      detailedRoots: false,
      insideWork: true,
      renderContext: options.renderContext === 'timeline-mixed' ? 'mixed-compact' : options.renderContext,
    });
  };
  const appendSessions = (options: AppendOptions): void => {
    for (const entry of collapseRunEntries(options.nodes, runIndex, options.archived)) {
      if (isRunEntry(entry)) appendRun(entry, options);
      else appendTrees([entry], options.baseDepth ?? 0, options);
    }
  };
  const appendTrees = (nodes: readonly SessionNode[], baseDepth: number, options: AppendOptions): void => {
    const stack = [...nodes].reverse().map((node) => ({ node, depth: baseDepth, directory: options.groupDirectory }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const rowKey = keyFor(`${options.containerKey}:session:${current.node.session.id}`);
      const directory = current.node.session.directory ?? current.directory;
      sessionById.set(current.node.session.id, current.node.session);
      const detailed = options.detailedRoots === true && current.depth === baseDepth;
      // Only a zone's works take its two lines; what nests under one stays a
      // one-line row of the zone, as it does under a project.
      const rowContext: SessionSidebarRenderContext = current.depth > baseDepth && options.renderContext === 'timeline-mixed'
        ? 'mixed-compact'
        : options.renderContext;
      // Whether its subsessions show, for a row that has some: the sidebar
      // animates the change like a header's.
      const expanded = search || args.expandedParents.has(expandedKey(rowContext, options.archived, current.node.session.id));
      push({
        kind: 'session',
        key: rowKey,
        estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : estimateSessionRow(rowContext),
        expanded: current.node.children.length > 0 ? expanded : undefined,
        forceExpanded: current.node.children.length > 0 ? search : undefined,
        detailed,
        node: current.node,
        blockingBadgeSessionScopes: current.depth === baseDepth
          ? options.getBlockingBadgeSessionScopes?.(current.node.session.id) ?? options.blockingBadgeSessionScopes
          : undefined,
        depth: current.depth,
        ownsWork: options.insideWork !== true && current.depth === baseDepth,
        projectId: options.projectId,
        groupDirectory: current.directory,
        ownerKey: options.ownerKey,
        selectionScopeKey: options.selectionScopeKey,
        archived: options.archived,
        renderContext: rowContext,
        secondaryMeta: options.getSecondaryMeta
          ? options.getSecondaryMeta(current.node.session.id)
          : options.secondaryMeta ?? null,
      });
      const subtreeRange = options.indexedNodes?.subtreeRangeByNode.get(current.node);
      const descendantRange = subtreeRange && subtreeRange[1] > subtreeRange[0] + 1
        ? Object.freeze([
          (options.selectionPoolOffset ?? 0) + subtreeRange[0] + 1,
          (options.selectionPoolOffset ?? 0) + subtreeRange[1],
        ] as const)
        : undefined;
      selectionEntries.push(Object.freeze({
        id: current.node.session.id,
        rowKey,
        scopeKey: options.selectionScopeKey,
        archived: options.archived,
        descendantRange,
      }));
      if (!expanded) continue;
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        const child = current.node.children[index];
        if (child) stack.push({ node: child, depth: current.depth + 1, directory });
      }
    }
  };

  // A group's search matches once the trees listed in a zone are taken out:
  // those render in Pinned or In work, which counts them. Zero means nothing to show.
  const groupSearchMatches = (group: SessionGroup): number => {
    const searchData = args.groupSearchDataByGroup.get(group);
    if (searchData?.hasMatch !== true) return 0;
    const movedToZone = inZone.size > 0 || movedSessionIds.size > 0 || scheduledIds.size > 0 ? searchData.filteredNodes.filter((node) => isMovedToZone(node.session.id)) : [];
    const sessionMatches = Math.max(0, searchData.matchedSessionCount - countSessionSearchMatches(movedToZone, args.normalizedQuery));
    return sessionMatches + searchData.folderNameMatchCount + (searchData.groupMatches ? 1 : 0);
  };

  const currentSessionId = args.currentSessionId ?? null;
  const holdsCurrentSession = (entry: ListedEntry): boolean => currentSessionId !== null && !isWorktreeEntry(entry) && (isRunEntry(entry)
    ? entry.lanes.some((lane) => lane.session.id === currentSessionId)
    : entry.session.id === currentSessionId);

  const appendGroup = (
    group: SessionGroup,
    groupKey: string,
    projectId: string | null,
    hideHeader: boolean,
    limits?: { initial?: number; pinnedAlwaysVisible?: boolean; renderContext: SessionSidebarRenderContext },
    placement: GroupPlacement = PROJECT_PLACEMENT,
    // The project's worktree groups by folder member id, for the root group,
    // whose folders may hold whole worktrees.
    worktreesByMemberId?: ReadonlyMap<string, WorktreeInFolder>,
    // For the root group: the project's other worktree works, listed among
    // its own works by their latest activity.
    listedWorktrees: readonly WorktreeInFolder[] = [],
  ): void => {
    // Row keys carry the placement, so a worktree listed in In work and kept
    // under its project too does not collide; collapse and Show more state
    // stay keyed by the group alone and are shared.
    const rowKeyBase = `${placement.keyPrefix}${groupKey}`;
    const searchData = args.groupSearchDataByGroup.get(group);
    if (search) {
      const matches = groupSearchMatches(group);
      if (matches === 0) return;
      searchMatchCount += matches;
    }
    const sourceNodes = (search ? searchData?.filteredNodes ?? [] : group.sessions)
      .filter((node) => !isMovedToZone(node.session.id))
      .sort((left, right) => compareNodes(left, right, pinned, args.sessionOrderIndex));
    const indexed = indexNodes(sourceNodes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    for (const [id, session] of indexed.sessionsById) sessionById.set(id, session);
    const ownerKey = getSessionFolderOwnerKey(projectId, group.directory);
    const storedCollapsed = !search && args.collapsedGroups.has(groupKey);
    // A worktree, space or archive header is a tree node of its own: its
    // folders and sessions sit one level under it. The project root group has
    // no header, so its contents sit right under the project.
    const contentDepth = hideHeader ? 0 : placement.depth + 1;
    const status = args.groupStatusByKey.get(groupKey);
    const groupLoaded = !status || status.state === 'ready';
    // Nothing to list: no sessions, no folders, and no loading or failure
    // line to show.
    // Drafts are left out of a search, which matches sessions.
    const groupDrafts = search ? EMPTY_DRAFTS : args.draftsByGroupKey?.get(groupKey) ?? EMPTY_DRAFTS;
    // With Detailed rows the works of the project root take two lines too:
    // its sessions and drafts, in its folders as well. A worktree's own
    // sessions and drafts are part of its work and stay one line.
    const detailedWorks = args.detailedZoneRows === true && group.isMain === true;
    // Their second line names the branch as a zone row's does: the project
    // root's, which every session there shares.
    const detailedMeta = detailedWorks && group.branch ? { branchLabel: group.branch } : undefined;
    const insideWork = isGroupWork(group);
    const empty = sourceNodes.length === 0
      && groupDrafts.length === 0
      && groupLoaded
      && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
    const appendDrafts = (): void => {
      for (const draft of groupDrafts) {
        push({ kind: 'draft', key: keyFor(`${rowKeyBase}:draft:${draft.id}`), estimateSize: detailedWorks ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE, draft, depth: contentDepth, projectId, mixed: false, detailed: detailedWorks });
      }
    };
    if (!hideHeader) {
      const allSessions = indexed.preorderIds.flatMap((id) => indexed.sessionsById.get(id) ?? []);
      const detailed = args.detailedZoneRows === true && isGroupWork(group);
      const estimateSize = detailed ? TIMELINE_SESSION_ESTIMATE : isGroupWork(group) ? SESSION_ESTIMATE : HEADER_ESTIMATE;
      push({ kind: 'group-header', key: `${rowKeyBase}:header`, estimateSize, group, groupKey, projectId, collapsed: storedCollapsed && !empty, forceExpanded: search, empty, allSessions: Object.freeze(allSessions), depth: placement.depth, mixed: placement.mixed, detailed });
    }
    // An empty group is always open, so its first session shows at once.
    if (storedCollapsed && !empty) return;

    const folderEntries = getSessionFolderScopes(group).flatMap(({ scopeKey, directory }) => (
      (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).map((folder): FolderProjection => ({
        folder,
        scopeKey,
        scopeDirectory: directory,
        ownerKey,
        nodes: selectFolderRootNodes(folder.sessionIds, indexed.byId).sort((left, right) => compareNodes(left, right, pinned, args.sessionOrderIndex)),
      }))
    ));
    const visibleFolderKeys = selectFolderIdsForProjection(folderEntries.map((entry) => ({
      id: entry.folder.id,
      name: entry.folder.name,
      parentId: entry.folder.parentId,
      nodeCount: entry.nodes.length,
    })), { archivedBucket: group.isArchivedBucket === true, searchQuery: search ? args.normalizedQuery : '' });
    const visibleFolders = folderEntries.filter((entry) => visibleFolderKeys.has(entry.folder.id));
    const entryByIdentity = new Map(visibleFolders.map((entry) => [getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id), entry]));
    const childFolders = new Map<string, FolderProjection[]>();
    for (const entry of visibleFolders) {
      if (!entry.folder.parentId) continue;
      const parentKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.parentId);
      const list = childFolders.get(parentKey) ?? [];
      list.push(entry);
      childFolders.set(parentKey, list);
    }
    const roots = normalizeFolderRoots(visibleFolders.map((entry) => ({ ...entry.folder, scopeKey: entry.scopeKey })))
      .map((folder) => entryByIdentity.get(getSessionFolderIdentityKey(folder.scopeKey ?? '', folder.id)))
      .filter((entry): entry is FolderProjection => Boolean(entry));
    const sessionsInFolders = new Set(visibleFolders.flatMap((entry) => entry.folder.sessionIds));
    const ungrouped = sourceNodes.filter((node) => !sessionsInFolders.has(node.session.id));

    const folderSessionsByIdentity = new Map<string, readonly Session[]>();
    const folderStack = roots.map((folder) => ({ folder, visited: false }));
    const seenFolderIds = new Set<string>();
    while (folderStack.length > 0) {
      const current = folderStack.pop();
      if (!current) continue;
      const identity = getSessionFolderIdentityKey(current.folder.scopeKey, current.folder.folder.id);
      if (!current.visited) {
        if (seenFolderIds.has(identity)) continue;
        seenFolderIds.add(identity);
        folderStack.push({ folder: current.folder, visited: true });
        for (const child of childFolders.get(identity) ?? []) folderStack.push({ folder: child, visited: false });
        continue;
      }
      const sessions = current.folder.nodes.flatMap((node) => {
        const range = indexed.subtreeRangeByNode.get(node);
        return range ? indexed.preorderIds.slice(range[0], range[1]).flatMap((id) => indexed.sessionsById.get(id) ?? []) : [node.session];
      });
      for (const child of childFolders.get(identity) ?? []) {
        sessions.push(...(folderSessionsByIdentity.get(getSessionFolderIdentityKey(child.scopeKey, child.folder.id)) ?? []));
      }
      folderSessionsByIdentity.set(identity, Object.freeze(sessions));
    }

    const renderedFolders = new Set<string>();
    const appendFolder = (entry: FolderProjection, parentPath: string): void => {
      const identity = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id);
      if (renderedFolders.has(identity)) return;
      renderedFolders.add(identity);
      const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
      const folderKey = `${rowKeyBase}:folder:${identity}`;
      // An empty folder is always open, so the first session moved in shows.
      // Until the group's sessions have loaded, a folder only looks empty.
      const folderWorktrees = worktreesByMemberId
        ? entry.folder.sessionIds.flatMap((memberId) => worktreesByMemberId.get(memberId) ?? [])
        : [];
      const folderEmpty = groupLoaded && entry.nodes.length === 0 && folderWorktrees.length === 0 && (childFolders.get(identity)?.length ?? 0) === 0;
      const folderCollapsed = !search && !folderEmpty && args.collapsedFolders.has(entry.folder.id);
      const deleteSessions = folderSessionsByIdentity.get(identity) ?? [];
      // A collapsed parent hides child folders too. Reuse their indexed session
      // coverage, retaining tree roots so unread-subtask rules remain intact.
      const activityNodes = folderCollapsed && !group.isArchivedBucket
        ? selectFolderRootNodes([...new Set(deleteSessions.map((session) => session.id))], indexed.byId)
        : [];
      const authority = ownerKey ? args.folderAuthorityByOwner.get(ownerKey) : undefined;
      const dropEnabled = Boolean(ownerKey)
        && !group.isArchivedBucket
        && !isArchivedFolderScope(entry.scopeKey)
        && authority?.complete === true
        && authority.scopeKeys.includes(entry.scopeKey);
      push({
        kind: 'folder-header', key: folderKey, estimateSize: HEADER_ESTIMATE, depth: contentDepth, group,
        folder: entry.folder, displayName, scopeKey: entry.scopeKey, scopeDirectory: entry.scopeDirectory,
        ownerKey, nodes: entry.nodes, activityNodes, projectId, archived: group.isArchivedBucket === true,
        collapsed: folderCollapsed, forceExpanded: search, empty: folderEmpty,
        deleteSessions,
        subFolderCount: childFolders.get(identity)?.length ?? 0, dropEnabled,
      });
      if (ownerKey) folderDropTargets.push(Object.freeze({ rowKey: folderKey, scopeKey: entry.scopeKey, folderId: entry.folder.id, ownerKey, enabled: dropEnabled }));
      if (folderCollapsed) return;
      appendSessions({ nodes: entry.nodes, containerKey: folderKey, projectId, groupDirectory: entry.scopeDirectory ?? group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth + 1, detailedRoots: detailedWorks, secondaryMeta: detailedMeta, insideWork });
      for (const worktree of folderWorktrees) {
        appendGroup(worktree.group, worktree.groupKey, projectId, false, undefined, {
          keyPrefix: '', depth: contentDepth + 1, mixed: false,
        });
      }
      for (const child of childFolders.get(identity) ?? []) appendFolder(child, displayName);
    };
    for (const folder of roots) appendFolder(folder, '');

    const initialLimit = limits?.initial ?? SESSIONS_INITIAL_LIMIT;
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(groupKey) ?? initialLimit);
    // Pinned sessions are the user's own always-on shortlist: they stay
    // visible whatever the reveal limit is, and they do not spend it.
    const isPinnedNode = (entry: ListedEntry): boolean => !isWorktreeEntry(entry) && !isRunEntry(entry) && limits?.pinnedAlwaysVisible === true
      && isSessionPinned(pinned, entry.session.directory ?? group.directory, entry.session.id);
    // A run spends one slot of the reveal limit, whatever its lane count, and
    // so does a worktree work.
    const ungroupedEntries = mergeWorktreeEntries(collapseRunEntries(ungrouped, runIndex, group.isArchivedBucket === true), listedWorktrees, args.sessionOrderIndex, args.worktreeArchiveAnchors ?? EMPTY_ARCHIVE_ANCHORS, args.liveSpaceIds ?? EMPTY_SPACE_IDS);
    // The open session stays listed too, so the list never hides where the user is.
    const isAlwaysVisible = (entry: ListedEntry): boolean => isPinnedNode(entry) || holdsCurrentSession(entry);
    const limitedNodes = ungroupedEntries.filter((entry) => !isAlwaysVisible(entry));
    let budget = requested;
    const visibleEntries = group.isArchivedBucket || search
      ? ungroupedEntries
      : ungroupedEntries.filter((entry) => {
        if (isAlwaysVisible(entry)) return true;
        if (budget <= 0) return false;
        budget -= 1;
        return true;
      });
    // A new work in the project root opens its list, newest first; a draft in
    // a worktree closes the worktree's list, after what was already sent there.
    if (group.isMain) appendDrafts();
    let pendingNodes: SessionNode[] = [];
    const flushSessions = (): void => {
      if (pendingNodes.length === 0) return;
      appendSessions({ nodes: pendingNodes, containerKey: rowKeyBase, projectId, groupDirectory: group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: limits?.renderContext ?? 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth, detailedRoots: detailedWorks, secondaryMeta: detailedMeta, insideWork });
      pendingNodes = [];
    };
    for (const entry of visibleEntries) {
      if (!isWorktreeEntry(entry)) {
        pendingNodes.push(...(isRunEntry(entry) ? entry.lanes : [entry]));
        continue;
      }
      flushSessions();
      appendGroup(entry.listedWorktree.group, entry.listedWorktree.groupKey, projectId, false, undefined, {
        keyPrefix: placement.keyPrefix, depth: contentDepth, mixed: placement.mixed,
      });
    }
    flushSessions();
    if (!group.isMain) appendDrafts();
    const remaining = ungroupedEntries.length - visibleEntries.length;
    if (!search && !group.isArchivedBucket && remaining > 0) {
      push({ kind: 'show-control', key: `${rowKeyBase}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey: groupKey, depth: contentDepth, flat: false });
    } else if (!search && !group.isArchivedBucket && limitedNodes.length > initialLimit && remaining === 0) {
      push({ kind: 'show-control', key: `${rowKeyBase}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey: groupKey, depth: contentDepth, flat: false });
    }

    // An empty group lists nothing: its header has no chevron, and new
    // sessions start from the header's own button. Only the archive bucket
    // says it is empty.
    if (sourceNodes.length === 0 && visibleFolders.length === 0) {
      if (status && status.state !== 'ready') push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth });
      else if (group.isArchivedBucket) push({ kind: 'empty', key: `${rowKeyBase}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'archived', depth: contentDepth });
    } else if (status && status.state !== 'ready' && status.state !== 'loading') {
      push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth });
    }
  };

  // `forceOpen`: the zone is the whole list (a status filter), so it cannot collapse.
  const appendActivityHeader = (activityKey: SessionSidebarActivityKey, forceOpen = false, count?: number): boolean => {
    const collapsed = !search && !forceOpen && args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: SECTION_HEADER_ESTIMATE, activityKey, collapsed, forceExpanded: search || forceOpen, count });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'activity', id: activityKey }));
    return collapsed;
  };

  type ActivityRunEntry = { run: MultiRunSummary; items: SessionSidebarActivityItem[] };
  type ActivityEntry = SessionSidebarActivityItem | ActivityRunEntry;
  const isActivityRunEntry = (entry: ActivityEntry): entry is ActivityRunEntry => 'run' in entry;
  const collapseActivityItems = (items: readonly SessionSidebarActivityItem[]): ActivityEntry[] => {
    const entries = collapseRunEntries(items.map((item) => item.node), runIndex, false);
    const itemByNode = new Map(items.map((item) => [item.node, item]));
    return entries.flatMap((entry): ActivityEntry[] => {
      if (!isRunEntry(entry)) {
        const item = itemByNode.get(entry);
        return item ? [item] : [];
      }
      return [{ run: entry.run, items: entry.lanes.flatMap((lane) => itemByNode.get(lane) ?? []) }];
    });
  };
  const appendActivityRun = (
    entry: ActivityRunEntry,
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
  ): void => {
    const first = entry.items[0];
    if (!first) return;
    const lanes = entry.items.map((item) => item.node);
    const indexed = indexNodes(lanes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    const ownerKey = getSessionFolderOwnerKey(first.projectId, first.groupDirectory);
    const metaById = new Map(entry.items.map((item) => [
      item.node.session.id,
      item.getSecondaryMeta ? item.getSecondaryMeta(item.node.session.id) : item.secondaryMeta,
    ]));
    const badgeScopesById = new Map(entry.items.map((item) => [item.node.session.id, item.blockingBadgeSessionScopes]));
    appendRun({ run: entry.run, lanes }, {
      nodes: lanes, containerKey, projectId: first.projectId, groupDirectory: first.groupDirectory,
      ownerKey, selectionScopeKey: null, archived: false, renderContext,
      getSecondaryMeta: (sessionId) => metaById.get(sessionId) ?? null,
      getBlockingBadgeSessionScopes: (sessionId) => badgeScopesById.get(sessionId),
      indexedNodes: indexed, selectionPoolOffset,
    });
  };

  // Activity items are only listed in zones, which count real matches only.
  const countZoneMatches = (item: SessionSidebarActivityItem): number => (
    item.searchMatchCount ?? countSessionTreeQueryMatches(item.node, args.normalizedQuery)
  );
  const appendActivityItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
  ): void => {
    for (const entry of collapseActivityItems(items)) {
      if (isActivityRunEntry(entry)) {
        appendActivityRun(entry, containerKey, renderContext);
        if (search) searchMatchCount += entry.items.reduce((total, item) => total + countZoneMatches(item), 0);
        continue;
      }
      const item = entry;
      const indexed = indexNodes([item.node]);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      const ownerKey = getSessionFolderOwnerKey(item.projectId, item.groupDirectory);
      appendSessions({
        nodes: [item.node], containerKey, projectId: item.projectId, groupDirectory: item.groupDirectory,
        // Zone lists carry no selection scope.
        ownerKey, selectionScopeKey: null, archived: false, renderContext,
        blockingBadgeSessionScopes: item.blockingBadgeSessionScopes,
        secondaryMeta: item.secondaryMeta, getSecondaryMeta: item.getSecondaryMeta, indexedNodes: indexed, selectionPoolOffset,
      });
      if (search) searchMatchCount += countZoneMatches(item);
    }
  };

  // Pinned, In work and the list by time mix every project's works: one-line
  // rows with the project's icon, two lines when the user asked for detailed rows.
  const zoneRenderContext: SessionSidebarRenderContext = args.detailedZoneRows ? 'timeline-mixed' : 'mixed-compact';

  /**
   * Works in a zone, in order. Consecutive session works go through one call,
   * so the lanes of a multi-run among them still collapse into one run row; a
   * worktree work is its group row with its sessions under it, naming its
   * project and kept out of the drag sort. A group counts its own search
   * matches.
   */
  /**
   * The members of one run listed together at the place of the first: a run
   * collapses into one row only within a batch of consecutive session works,
   * and a worktree work between two members (a fusion that just moved up)
   * split it into two rows of the same run.
   */
  const gatherRunMembers = (entries: readonly SessionSidebarWorkEntry[]): readonly SessionSidebarWorkEntry[] => {
    if (runIndex.runKeyBySessionId.size === 0) return entries;
    const runKeyOf = (entry: SessionSidebarWorkEntry): string | undefined => (
      entry.kind === 'session' ? runIndex.runKeyBySessionId.get(entry.item.node.session.id) : undefined
    );
    const membersByRun = new Map<string, SessionSidebarWorkEntry[]>();
    for (const entry of entries) {
      const runKey = runKeyOf(entry);
      if (runKey) membersByRun.set(runKey, [...(membersByRun.get(runKey) ?? []), entry]);
    }
    if (membersByRun.size === 0) return entries;
    const placed = new Set<string>();
    return entries.flatMap((entry) => {
      const runKey = runKeyOf(entry);
      if (!runKey) return [entry];
      if (placed.has(runKey)) return [];
      placed.add(runKey);
      return membersByRun.get(runKey) ?? [entry];
    });
  };

  const appendWorkEntries = (allEntries: readonly SessionSidebarWorkEntry[], containerKey: string): void => {
    const entries = gatherRunMembers(allEntries);
    let pending: SessionSidebarActivityItem[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      appendActivityItems(pending, containerKey, zoneRenderContext);
      pending = [];
    };
    for (const entry of entries) {
      if (entry.kind === 'session') {
        pending.push(entry.item);
        continue;
      }
      flush();
      if (entry.kind === 'draft') {
        const detailed = args.detailedZoneRows === true;
        push({ kind: 'draft', key: keyFor(`${containerKey}:draft:${entry.draft.id}`), estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE, draft: entry.draft, depth: 0, projectId: entry.projectId, mixed: true, detailed });
        continue;
      }
      appendGroup(entry.group, entry.groupKey, entry.projectId, false, undefined, {
        keyPrefix: `${containerKey}:`, depth: 0, mixed: true,
      });
    }
    flush();
  };

  const appendRemoteSessions = (items: readonly RemoteSessionItem[], containerKey: string): void => {
    for (const item of items) {
      push({
        kind: 'remote-session',
        key: keyFor(`${containerKey}:remote:${item.host.runtimeKey}:${item.session.id}`),
        estimateSize: TIMELINE_SESSION_ESTIMATE,
        item,
        renderContext: 'timeline-mixed',
        dimmed: false,
        depth: 0,
        expansionKey: remoteExpansionKey(item),
        expanded: false,
      });
    }
  };

  const appendRemoteTree = (item: RemoteSessionItem, depth: number, containerKey: string, dimmed: boolean): void => {
    const expansionKey = remoteExpansionKey(item);
    const expanded = item.children.length > 0 && (search || args.expandedParents.has(expansionKey));
    push({
      kind: 'remote-session',
      key: keyFor(`${containerKey}:remote:${item.host.runtimeKey}:${item.session.id}`),
      estimateSize: SESSION_ESTIMATE,
      item,
      renderContext: 'tree',
      dimmed,
      depth,
      expansionKey,
      expanded,
    });
    if (!expanded) return;
    for (const child of item.children) appendRemoteTree(child, depth + 1, containerKey, dimmed);
  };

  /**
   * A list that reveals `initial` entries, then the rest on Show more. A run
   * spends one slot, the open session none; search lists everything.
   */
  const appendRevealedItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
    initialLimit: number,
  ): void => {
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(containerKey) ?? initialLimit);
    const entries = collapseActivityItems(items);
    let budget = requested;
    const visibleEntries = search ? entries : entries.filter((entry) => {
      const current = isActivityRunEntry(entry)
        ? entry.items.some((item) => item.node.session.id === currentSessionId)
        : entry.node.session.id === currentSessionId;
      if (current) return true;
      if (budget <= 0) return false;
      budget -= 1;
      return true;
    });
    appendActivityItems(visibleEntries.flatMap((entry) => isActivityRunEntry(entry) ? entry.items : [entry]), containerKey, renderContext);
    if (search) return;
    const total = entries.length;
    const shown = visibleEntries.length;
    if (total > shown) push({ kind: 'show-control', key: `${containerKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey, flat: true });
    else if (total > initialLimit) push({ kind: 'show-control', key: `${containerKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey, flat: true });
  };

  const appendHostHeader = (header: SessionSidebarHostHeader, runtimeKey: string, newSession: SessionSidebarHostNewSession | null): boolean => {
    const collapsed = !search && args.hosts !== undefined && args.hosts.collapsed.has(runtimeKey);
    const rowIndex = rows.length;
    push({ kind: 'host-header', key: `host:${runtimeKey}:header`, estimateSize: HEADER_ESTIMATE, runtimeKey, header, collapsed, forceExpanded: search, newSession });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'host', id: runtimeKey }));
    return collapsed;
  };

  const appendHostPage = <T>(
    runtimeKey: string,
    entries: readonly HostSessionEntry<T>[],
    appendVisible: (visible: readonly T[], containerKey: string) => void,
  ): void => {
    const containerKey = hostSessionListKey(runtimeKey);
    const sorted = sortHostSessionEntries(entries, args.hosts?.sort);
    const requested = Math.max(HOST_SESSION_INITIAL_COUNT, args.visibleCountByContainer.get(containerKey) ?? HOST_SESSION_INITIAL_COUNT);
    const page = selectHostSessionPage(sorted, search ? Number.POSITIVE_INFINITY : requested);
    appendVisible(page.visible, containerKey);
    if (search) return;
    if (page.hiddenCount > 0) {
      push({ kind: 'show-control', key: `${containerKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey });
    } else if (page.canShowFewer) {
      push({ kind: 'show-control', key: `${containerKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey });
    }
  };

  const pruneRemoteTree = (item: RemoteSessionItem): RemoteSessionItem | null => {
    const children = item.children.flatMap((child) => pruneRemoteTree(child) ?? []);
    if (children.length === 0 && !remoteSessionMatchesQuery(item, args.normalizedQuery)) return null;
    return children.length === item.children.length ? item : { ...item, children };
  };
  const countRemoteMatches = (items: readonly RemoteSessionItem[]): number => items.reduce((total, item) => (
    total + (remoteSessionMatchesQuery(item, args.normalizedQuery) ? 1 : 0) + countRemoteMatches(item.children)
  ), 0);

  const appendActiveHost = (shown: SessionSidebarHosts, listedInWork: ReadonlySet<string>): void => {
    const localEntries = shown.activeSessions.filter((entry) => !scheduledIds.has(entry.id) && !(search && listedInWork.has(entry.id)));
    if (!search || localEntries.length > 0) {
      const collapsed = appendHostHeader({ kind: 'active', descriptor: shown.active }, shown.activeRuntimeKey, shown.activeNewSession);
      if (!collapsed && localEntries.length === 0) push({ kind: 'empty', key: 'sidebar:empty', estimateSize: 72, emptyKind: 'sidebar' });
      if (!collapsed) {
        appendHostPage(shown.activeRuntimeKey, localEntries, (visible, containerKey) => {
          appendActivityItems(visible, containerKey, 'project');
        });
      }
    }
  };

  const appendMonitoredHost = (host: SidebarRemoteHost, listedInWork: ReadonlySet<string>): void => {
    const runtimeKey = host.descriptor.runtimeKey;
    const listed = groupScheduled ? host.sessions.filter((item) => !isRemoteScheduledRun(item)) : host.sessions;
    const sessions = search
      ? listed.flatMap((item) => pruneRemoteTree(item) ?? []).filter((item) => !listedInWork.has(remoteExpansionKey(item)))
      : listed;
    if (search && sessions.length === 0) return;
    const newSession = host.newSessionDirectory ? { projectId: null, directory: host.newSessionDirectory } : null;
    if (appendHostHeader({ kind: 'monitored', host }, runtimeKey, newSession)) return;
    const dimmed = host.connection.state !== 'live' || host.snapshotStatus !== 'ready';
    if (!search && (dimmed || host.sessions.length === 0)) {
      push({ kind: 'host-status', key: `host:${runtimeKey}:status`, estimateSize: STATUS_ESTIMATE, host });
    }
    const entries = sessions.map((item): HostSessionEntry<RemoteSessionItem> => ({
      id: item.session.id,
      value: item,
      title: item.session.title,
      createdAt: item.session.createdAt ?? item.session.updatedAt,
      updatedAt: item.session.updatedAt,
      waiting: isRemoteWaiting(item),
      running: isRunningState(item.liveState),
      pinned: item.session.pinned === true,
      current: false,
    }));
    appendHostPage(runtimeKey, entries, (visible, containerKey) => {
      for (const item of visible) appendRemoteTree(item, 0, containerKey, dimmed);
      if (search) searchMatchCount += countRemoteMatches(visible);
    });
  };

  const appendHostLists = (shown: SessionSidebarHosts, listedInWork: ReadonlySet<string>): void => {
    const slots = new Map<string, SidebarRemoteHost | null>([
      [shown.activeRuntimeKey, null],
      ...shown.monitored.map((host): [string, SidebarRemoteHost] => [host.descriptor.runtimeKey, host]),
    ]);
    const orderedKeys = new Set([...shown.order.filter((key) => slots.has(key)), ...slots.keys()]);
    for (const runtimeKey of orderedKeys) {
      const host = slots.get(runtimeKey);
      if (host) appendMonitoredHost(host, listedInWork);
      else appendActiveHost(shown, listedInWork);
    }
  };

  type MergedZoneEntry = { kind: 'local'; item: SessionSidebarActivityItem } | { kind: 'remote'; item: RemoteSessionItem };

  const sortMergedZone = (
    shown: SessionSidebarHosts,
    local: readonly SessionSidebarActivityItem[],
    remote: readonly RemoteSessionItem[],
  ): MergedZoneEntry[] => {
    const hostRankOf = (runtimeKey: string): number => {
      const index = shown.order.indexOf(runtimeKey);
      return index < 0 ? shown.order.length : index;
    };
    const localStateById = new Map(shown.activeSessions.map((entry) => [entry.id, entry]));
    const keyOf = (entry: MergedZoneEntry): SortableSession => {
      if (entry.kind === 'remote') {
        const { session } = entry.item;
        return {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt ?? session.updatedAt,
          updatedAt: session.updatedAt,
          hostRank: hostRankOf(entry.item.host.runtimeKey),
          statusRank: sessionStatusRank({ waiting: isRemoteWaiting(entry.item), running: isRunningState(entry.item.liveState) }),
          pinned: session.pinned === true,
        };
      }
      const { session } = entry.item.node;
      const state = localStateById.get(session.id);
      return {
        id: session.id,
        title: session.title ?? '',
        createdAt: session.time?.created ?? 0,
        updatedAt: session.time?.updated ?? 0,
        hostRank: hostRankOf(shown.activeRuntimeKey),
        statusRank: sessionStatusRank({ waiting: state?.waiting ?? false, running: state?.running ?? false }),
        pinned: state?.pinned ?? false,
      };
    };
    return sortSessionsBy<MergedZoneEntry>([
      ...local.map((item): MergedZoneEntry => ({ kind: 'local', item })),
      ...remote.map((item): MergedZoneEntry => ({ kind: 'remote', item })),
    ], shown.sort, keyOf);
  };

  const appendMergedEntries = (entries: readonly MergedZoneEntry[], containerKey: string): void => {
    let pending: SessionSidebarActivityItem[] = [];
    const flush = (): void => {
      if (pending.length > 0) appendActivityItems(pending, containerKey, zoneRenderContext);
      pending = [];
    };
    for (const entry of entries) {
      if (entry.kind === 'local') {
        pending.push(entry.item);
        continue;
      }
      flush();
      appendRemoteSessions([entry.item], containerKey);
    }
    flush();
  };

  const appendMergedZone = (
    shown: SessionSidebarHosts,
    local: readonly SessionSidebarActivityItem[],
    remote: readonly RemoteSessionItem[],
    containerKey: string,
  ): void => {
    appendMergedEntries(sortMergedZone(shown, local, remote), containerKey);
    if (search) searchMatchCount += remote.length;
  };

  // Other hosts' sessions that wait on the user or run now join the status
  // filters after this host's, named by their host. A search keeps the
  // matching ones.
  const hosts = args.hosts ?? null;
  const matchesQuery = (item: RemoteSessionItem): boolean => !search || remoteSessionMatchesQuery(item, args.normalizedQuery);

  const appendScheduledZone = (remote: readonly RemoteSessionItem[]): void => {
    const total = scheduledItems.length + remote.length;
    if (total === 0) return;
    const containerKey = 'activity:scheduled';
    const collapsed = appendActivityHeader('scheduled', false, total);
    const entries = hosts
      ? sortMergedZone(hosts, scheduledItems, remote)
      : scheduledItems.map((item): MergedZoneEntry => ({ kind: 'local', item }));
    const requested = Math.max(SCHEDULED_INITIAL_LIMIT, args.visibleCountByContainer.get(containerKey) ?? SCHEDULED_INITIAL_LIMIT);
    let budget = collapsed ? 0 : search ? Number.POSITIVE_INFINITY : requested;
    const visible = entries.filter((entry) => {
      if (entry.kind === 'local' && entry.item.node.session.id === currentSessionId) return true;
      if (budget <= 0) return false;
      budget -= 1;
      return true;
    });
    appendMergedEntries(visible, containerKey);
    if (search) {
      searchMatchCount += visible.filter((entry) => entry.kind === 'remote').length;
      return;
    }
    if (collapsed) return;
    if (entries.length > visible.length) {
      push({ kind: 'show-control', key: `${containerKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey, flat: true });
    } else if (entries.length > SCHEDULED_INITIAL_LIMIT) {
      push({ kind: 'show-control', key: `${containerKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey, flat: true });
    }
  };

  // The status filter replaces the whole list with one zone, shown in full.
  const statusFilter = args.statusFilter ?? 'all';
  if (statusFilter !== 'all') {
    const filterKey = statusFilter === 'attention' ? 'attention' : 'running';
    const filterItems = (statusFilter === 'attention' ? args.attentionItems : args.runningItems) ?? [];
    const items = hosts ? filterItems : sortZoneItems(filterItems);
    const selectRemote = statusFilter === 'attention' ? selectRemoteAttention : selectRemoteRunning;
    const remote = hosts ? selectRemote(hosts.monitored).filter(matchesQuery) : [];
    if (items.length + remote.length > 0) {
      appendActivityHeader(filterKey, true, items.length + remote.length);
      if (hosts) {
        appendMergedZone(hosts, items, remote, `activity:${filterKey}`);
      } else {
        appendActivityItems(items, `activity:${filterKey}`, zoneRenderContext);
      }
    } else {
      push({
        kind: 'empty',
        key: `sidebar:${statusFilter}-filter-empty`,
        estimateSize: 72,
        emptyKind: search ? 'search' : statusFilter === 'attention' ? 'attention-filter' : 'running-filter',
      });
    }
    return finishModel();
  }

  // A zone a search left empty shows no header: search filters the entries
  // the collection passes, and a worktree work's group may still match nothing.
  const matchesSearch = (entry: SessionSidebarWorkEntry): boolean => (
    !search || entry.kind === 'session' || (entry.kind === 'group' && groupSearchMatches(entry.group) > 0)
  );

  if (hosts) {
    // Pinned opens the list and gathers every host's pinned sessions, each
    // row named by its host; the host lists below leave them out.
    const pinnedItems = args.pinnedItems ?? [];
    const pinnedWorktrees = (args.pinnedWorktrees ?? []).filter(matchesSearch);
    // A search lists each match once: one "Needs you" lists stays there.
    const remoteAttentionKeys = search ? new Set(hosts.attention.map(remoteExpansionKey)) : null;
    const remotePinned = hosts.pinned.filter((item) => matchesQuery(item) && !remoteAttentionKeys?.has(remoteExpansionKey(item)));
    if (pinnedItems.length + pinnedWorktrees.length + remotePinned.length > 0 && !appendActivityHeader('pinned')) {
      appendMergedZone(hosts, pinnedItems, remotePinned, 'activity:pinned');
      appendWorkEntries(pinnedWorktrees, 'activity:pinned');
    }
    const attentionItems = args.attentionItems ?? [];
    const remoteAttention = hosts.attention.filter(matchesQuery);
    const attentionCount = attentionItems.length + remoteAttention.length;
    if (attentionCount > 0 && !appendActivityHeader('attention', false, attentionCount)) {
      appendMergedZone(hosts, attentionItems, remoteAttention, 'activity:attention');
    }
    const localWork = (args.workEntries ?? []).filter(matchesSearch);
    const workItems = localWork.flatMap((entry) => entry.kind === 'session' ? [entry.item] : []);
    const otherWork = localWork.filter((entry) => entry.kind !== 'session');
    const remoteWork = hosts.work.filter(matchesQuery);
    if (localWork.length + remoteWork.length > 0 && !appendActivityHeader('work')) {
      appendMergedZone(hosts, workItems, remoteWork, 'activity:work');
      appendWorkEntries(otherWork, 'activity:work');
    }
    appendHostLists(hosts, new Set([
      ...pinnedItems.map((item) => item.node.session.id),
      ...remotePinned.map(remoteExpansionKey),
      ...attentionItems.map((item) => item.node.session.id),
      ...remoteAttention.map(remoteExpansionKey),
      ...workItems.map((item) => item.node.session.id),
      ...remoteWork.map(remoteExpansionKey),
    ]));
    appendScheduledZone(groupScheduled ? selectRemoteScheduled(hosts.monitored).filter(matchesQuery) : []);
    if (rows.length === 0) push({ kind: 'empty', key: 'sidebar:search-empty', estimateSize: 72, emptyKind: 'search' });
    return finishModel();
  }

  // "Needs you" opens the list: what waits on the user comes before anything
  // they might browse. A search lists each match once, here.
  const attentionItems = sortZoneItems(args.attentionItems ?? []);
  if (attentionItems.length > 0) {
    const collapsed = appendActivityHeader('attention', false, attentionItems.length);
    if (!collapsed) {
      if (search) {
        appendActivityItems(attentionItems, 'activity:attention', zoneRenderContext);
      } else {
        appendRevealedItems(attentionItems, 'activity:attention', zoneRenderContext, ATTENTION_INITIAL_LIMIT);
      }
    }
  }

  // This window's host: Chats, Pinned, In work, then the projects.
  if (args.chatGroup) {
    if (!search || groupSearchMatches(args.chatGroup) > 0) {
      const collapsed = appendActivityHeader('chats');
      if (!collapsed) {
        // Chats are one-line rows with the tree's state slot, on a short page
        // that pinned chats do not spend.
        appendGroup(args.chatGroup, 'activity:chats', null, true, {
          initial: CHATS_INITIAL_LIMIT, pinnedAlwaysVisible: true,
          renderContext: 'tree-chat',
        });
      }
    }
  }

  // Pinned and then In work sit under Chats and above the projects. A tree
  // is listed for its matching subsession too; the ancestors around it are
  // context, so only real matches count.
  const pinnedItems = sortZoneItems(args.pinnedItems ?? []);
  const pinnedWorktrees = (args.pinnedWorktrees ?? []).filter(matchesSearch);
  if (pinnedItems.length > 0 || pinnedWorktrees.length > 0) {
    const collapsed = appendActivityHeader('pinned');
    if (!collapsed) {
      appendActivityItems(pinnedItems, 'activity:pinned', zoneRenderContext);
      appendWorkEntries(pinnedWorktrees, 'activity:pinned');
    }
  }
  const workEntries = sortZoneEntries((args.workEntries ?? []).filter(matchesSearch));
  if (workEntries.length > 0) {
    const collapsed = appendActivityHeader('work');
    if (!collapsed) appendWorkEntries(workEntries, 'activity:work');
  }

  // Keep the selected project's picker even when search has no matches there.
  const selectedSection = args.singleProjectMode
    ? args.sections.find((section) => section.project.id === args.singleProjectId)
      ?? args.authoritativeSections.find((section) => section.project.id === args.singleProjectId)
    : undefined;
  const sections = args.singleProjectMode ? selectedSection ? [selectedSection] : [] : args.sections;

  const timeEntries = args.singleProjectMode ? null : args.timeEntries ?? null;
  if (timeEntries) {
    // One list of every other work of every project, most recent first, under
    // one zone header. It is virtualized, so it reveals all of them at once.
    // Scheduled runs close the list in their own zone.
    const entries = timeEntries.filter((entry) => matchesSearch(entry) && !(entry.kind === 'session' && scheduledIds.has(entry.item.node.session.id)));
    if (entries.length > 0) {
      const collapsed = appendActivityHeader('timeline');
      if (!collapsed) appendWorkEntries(entries, 'activity:timeline');
    }
    // The list has no project headers to hold a load status, so it closes
    // with one line per distinct status of a project it lists nothing for,
    // as a project header would: one while any loads, and one per failure,
    // whose Retry reloads that directory or the global list.
    if (!search && !(entries.length > 0 && args.collapsedActivities.has('timeline'))) {
      const listedProjects = new Set(timeEntries.map((entry) => entry.kind === 'session' ? entry.item.projectId : entry.projectId));
      const shown = new Set<string>();
      for (const section of args.sections) {
        if (listedProjects.has(section.project.id)) continue;
        const mainGroup = section.groups.find((group) => group.isMain);
        if (!mainGroup) continue;
        const groupKey = `${section.project.id}:${mainGroup.id}`;
        const status = args.groupStatusByKey.get(groupKey);
        if (!status || status.state === 'ready') continue;
        const identity = status.state === 'loading' ? 'loading' : `${status.state}:${status.directory ?? ''}`;
        if (shown.has(identity)) continue;
        shown.add(identity);
        push({ kind: 'status', key: `activity:timeline:status:${groupKey}`, estimateSize: STATUS_ESTIMATE, status, group: mainGroup, groupKey, flat: true });
      }
    }
  }

  let projectSections = timeEntries ? [] : [...sections];
  if (args.showOnlyMainWorkspace) {
    const active = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
    projectSections = active ? [active] : [];
  }
  for (const section of projectSections) {
    const descriptors = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: args.showOnlyMainWorkspace });
    // A project whose only matches moved to a zone shows no empty header.
    if (search && !descriptors.some((descriptor) => !movedGroupKeys.has(descriptor.groupKey) && groupSearchMatches(descriptor.group) > 0)) continue;
    const projectCollapsed = !search && !args.singleProjectMode && !args.showOnlyMainWorkspace && args.collapsedProjects.has(section.project.id);
    if (!args.showOnlyMainWorkspace) {
      const rowIndex = rows.length;
      push({ kind: 'project-header', key: `project:${section.project.id}:header`, estimateSize: SECTION_HEADER_ESTIMATE, section, collapsed: projectCollapsed, forceExpanded: search });
      stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: section.project.id }));
    }
    if (projectCollapsed) continue;
    // Worktrees filed into a folder of the project root render inside it, and
    // only there; one filed into a folder that is gone stays under the project.
    // A search lists them as plain worktrees: folders show only where their
    // own sessions match.
    const worktreesByMemberId = new Map<string, WorktreeInFolder>();
    const rootGroup = search ? undefined : descriptors.find((descriptor) => descriptor.group.isMain)?.group;
    const rootFolderMembers = new Set(rootGroup
      ? getSessionFolderScopes(rootGroup).flatMap(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).flatMap((folder) => folder.sessionIds))
      : []);
    for (const descriptor of descriptors) {
      const memberId = isGroupWork(descriptor.group) ? worktreeFolderMemberId(descriptor.group.directory) : null;
      if (memberId && rootFolderMembers.has(memberId) && !movedGroupKeys.has(descriptor.groupKey)) {
        worktreesByMemberId.set(memberId, { group: descriptor.group, groupKey: descriptor.groupKey });
      }
    }
    const filedGroupKeys = new Set([...worktreesByMemberId.values()].map((entry) => entry.groupKey));
    // A worktree is a work like any other of the project: it is listed among
    // the root's works rather than in a block after them. Only a project with
    // no root group (a single worktree shown alone) lists them on their own.
    const hasRootGroup = descriptors.some((descriptor) => descriptor.group.isMain);
    const listedWorktrees = hasRootGroup ? descriptors
      .filter((descriptor) => isGroupWork(descriptor.group)
        && !movedGroupKeys.has(descriptor.groupKey) && !filedGroupKeys.has(descriptor.groupKey))
      .map((descriptor): WorktreeInFolder => ({ group: descriptor.group, groupKey: descriptor.groupKey })) : [];
    const listedGroupKeys = new Set(listedWorktrees.map((entry) => entry.groupKey));
    for (const descriptor of descriptors) {
      // A worktree work In work lists has left its project.
      if (movedGroupKeys.has(descriptor.groupKey) || filedGroupKeys.has(descriptor.groupKey) || listedGroupKeys.has(descriptor.groupKey)) continue;
      appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel, undefined, PROJECT_PLACEMENT,
        descriptor.group.isMain ? worktreesByMemberId : undefined, descriptor.group.isMain ? listedWorktrees : undefined);
    }
  }

  appendScheduledZone([]);

  if (rows.length === 0 || (search && args.singleProjectMode && searchMatchCount === 0)) {
    push({ kind: 'empty', key: search ? 'sidebar:search-empty' : 'sidebar:empty', estimateSize: 72, emptyKind: search ? 'search' : 'sidebar' });
  }
  return finishModel();
};

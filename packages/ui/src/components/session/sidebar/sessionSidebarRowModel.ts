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
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { EMPTY_MULTI_RUN_INDEX, type MultiRunIndex, type MultiRunSummary } from '@/lib/multirun/runs';
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
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null; projectChip?: string | null } | null;
  getSecondaryMeta?: (sessionId: string) => SessionSidebarActivityItem['secondaryMeta'];
  /** Search matches in the session's whole tree, for zone rows whose node drops its children. */
  searchMatchCount?: number;
};

/**
 * Zones above the projects. `attention` ("Needs you") lists sessions waiting
 * on the user or with a failed turn nobody has seen; `running` is what the
 * Running filter shows. The host level (one header per OpenChamber host above
 * its zones and projects) is a row kind of its own, so zones stay keyed the
 * same under it.
 */
export type SessionSidebarActivityKey = 'attention' | 'running' | 'pinned' | 'work' | 'chats' | 'scheduled';

/**
 * Activity sections; the display menu's Collapse all / Expand all drive them
 * with the projects. "Needs you" is left out: it lists what is waiting on the
 * user, so tidying the list must not hide it.
 */
export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = ['chats', 'pinned', 'work', 'scheduled'];

/**
 * What the header's status filter shows: everything, only the "Needs you"
 * zone, or only the sessions running now.
 */
export type SessionSidebarStatusFilter = 'all' | 'attention' | 'running';

// 'project' is a one-line file tree row of the grouped view. Timeline rows
// have no left gutter and carry their status on the right: 'timeline' is a
// two-line row under its project header; 'timeline-mixed' is the same row in
// Pinned and In work, where sessions of every project mix, so its second line
// opens with the project's icon; 'mixed-compact' is that row on one line, the
// Tree view's default for Pinned and In work; 'timeline-chat' is a one-line
// Chats row in List, 'tree-chat' the same row in Tree.
export type SessionSidebarRenderContext = 'project' | 'timeline' | 'timeline-mixed' | 'mixed-compact' | 'timeline-chat' | 'tree-chat';

/**
 * Rows that keep the tree's geometry and its slot left of the title, which
 * shows the live state: everything in Tree but the detailed zone rows. List
 * rows are flat and show the state on the right.
 */
export const hasTreeSlotContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'project' || context === 'mixed-compact' || context === 'tree-chat'
);

/** Rows that render through `SessionTimelineRowBody` with two lines. */
export const isTwoLineTimelineContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'timeline' || context === 'timeline-mixed'
);

/** Flat zone and timeline rows never expand: a run row opens its overview instead. */
const isNeverExpandedContext = (context: SessionSidebarRenderContext): boolean => (
  isTwoLineTimelineContext(context) || context === 'mixed-compact'
);

export type SessionSidebarViewMode = 'projects' | 'timeline';

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

type RowBase = { key: string; estimateSize: number };

export type SessionSidebarRow =
  // `count`: how many sessions the zone holds, shown beside "Needs you" so a
  // collapsed zone still says that something waits.
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; forceExpanded: boolean; count?: number })
  | (RowBase & { kind: 'project-header'; section: ProjectSection; collapsed: boolean; forceExpanded: boolean })
  // `empty`: nothing to list under the header, so it offers no chevron.
  | (RowBase & { kind: 'group-header'; group: SessionGroup; groupKey: string; projectId: string | null; collapsed: boolean; forceExpanded: boolean; empty: boolean; allSessions: readonly Session[] })
  | (RowBase & { kind: 'folder-header'; depth: number; group: SessionGroup; folder: SessionFolder; displayName: string; scopeKey: string; scopeDirectory: string | null; ownerKey: string | null; nodes: readonly SessionNode[]; activityNodes: readonly SessionNode[]; projectId: string | null; archived: boolean; collapsed: boolean; forceExpanded: boolean; empty: boolean; deleteSessions: readonly Session[]; subFolderCount: number; dropEnabled: boolean })
  | (RowBase & { kind: 'session'; node: SessionNode; blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[]; depth: number; projectId: string | null; groupDirectory: string | null; ownerKey: string | null; selectionScopeKey: string | null; archived: boolean; renderContext: SessionSidebarRenderContext; secondaryMeta: SessionSidebarActivityItem['secondaryMeta'] })
  // A multi-run: one derived parent row over its member sessions. It is not a
  // session, so it never enters selection, and its lanes render as session
  // rows one level deeper when it is expanded.
  | (RowBase & { kind: 'run'; run: MultiRunSummary; depth: number; laneNodes: readonly SessionNode[]; blockingSessionIds: readonly string[]; projectId: string | null; projectLabel: string | null; groupDirectory: string | null; renderContext: SessionSidebarRenderContext; expansionKey: string; expanded: boolean; forceExpanded: boolean })
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
  /**
   * Projects renders the project/worktree tree. Timeline renders one header
   * per project over a flat, lifecycle-ordered list of its non-archived root
   * sessions, with no worktree groups or folders.
   */
  viewMode?: SessionSidebarViewMode;
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  /** Every non-archived root project session with its project, in lifecycle order. */
  timelineItems?: readonly SessionSidebarActivityItem[];
  /**
   * Pinned sessions and sessions in work, already ordered and
   * search-filtered. Each zone renders as its own block at the top, and its
   * sessions stay under their project too. Search lists each of them once,
   * in its zone.
   */
  pinnedItems?: readonly SessionSidebarActivityItem[];
  workItems?: readonly SessionSidebarActivityItem[];
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
  /** Every session listed in the Needs you, Pinned or In work zone. */
  zoneSessionIds?: ReadonlySet<string>;
  /** Pinned and In work rows in the Tree view: two lines when set, one otherwise. */
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
const SESSION_ESTIMATE = 32;
const TIMELINE_SESSION_ESTIMATE = 52;
// Chats open on a short page in both views, with pinned chats on top of it.
const CHATS_INITIAL_LIMIT = 3;
// "Needs you" shows its first few above the list; the filter shows them all.
const ATTENTION_INITIAL_LIMIT = 5;
// Project and worktree lists open on 3 sessions and reveal the rest on Show more in both views.
const SESSIONS_INITIAL_LIMIT = 3;
const SCHEDULED_INITIAL_LIMIT = 3;

/** Show more / Show fewer state of a project's session list in the timeline. */
export const timelineProjectContainerKey = (projectId: string): string => `timeline-project:${projectId}`;
const HEADER_ESTIMATE = 32;
const STATUS_ESTIMATE = 28;

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
  // A pinned session or one in work also stays in its project; only search
  // lists it once, in its zone, so its count and rows agree.
  const isMovedToZone = (sessionId: string): boolean => (search && inZone.has(sessionId)) || scheduledIds.has(sessionId);
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
    // Nesting level of the container's top rows: 1 inside a folder, so its
    // sessions indent under the folder header like subagent children do.
    baseDepth?: number;
  };
  const runIndex = args.runIndex ?? EMPTY_MULTI_RUN_INDEX;
  const appendRun = (entry: RunEntry, options: AppendOptions): void => {
    const expansionKey = runExpansionKey(options.renderContext, entry.run.key);
    // Timeline rows never expand; the overview lists the lanes.
    const expanded = !isNeverExpandedContext(options.renderContext) && (search || args.expandedParents.has(expansionKey));
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
      estimateSize: isTwoLineTimelineContext(options.renderContext) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE,
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
    appendTrees(entry.lanes, (options.baseDepth ?? 0) + 1, options);
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
      push({
        kind: 'session',
        key: rowKey,
        estimateSize: isTwoLineTimelineContext(options.renderContext) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE,
        node: current.node,
        blockingBadgeSessionScopes: current.depth === baseDepth
          ? options.getBlockingBadgeSessionScopes?.(current.node.session.id) ?? options.blockingBadgeSessionScopes
          : undefined,
        depth: current.depth,
        projectId: options.projectId,
        groupDirectory: current.directory,
        ownerKey: options.ownerKey,
        selectionScopeKey: options.selectionScopeKey,
        archived: options.archived,
        renderContext: options.renderContext,
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
      if (!search && !args.expandedParents.has(expandedKey(options.renderContext, options.archived, current.node.session.id))) continue;
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
    const movedToZone = inZone.size > 0 || scheduledIds.size > 0 ? searchData.filteredNodes.filter((node) => isMovedToZone(node.session.id)) : [];
    const sessionMatches = Math.max(0, searchData.matchedSessionCount - countSessionSearchMatches(movedToZone, args.normalizedQuery));
    return sessionMatches + searchData.folderNameMatchCount + (searchData.groupMatches ? 1 : 0);
  };

  const currentSessionId = args.currentSessionId ?? null;
  const holdsCurrentSession = (entry: SidebarEntry): boolean => currentSessionId !== null && (isRunEntry(entry)
    ? entry.lanes.some((lane) => lane.session.id === currentSessionId)
    : entry.session.id === currentSessionId);

  const appendGroup = (
    group: SessionGroup,
    groupKey: string,
    projectId: string | null,
    hideHeader: boolean,
    limits?: { initial?: number; pinnedAlwaysVisible?: boolean; renderContext: SessionSidebarRenderContext },
  ): void => {
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
    const contentDepth = hideHeader ? 0 : 1;
    // Chats render gutterless rows in List; in Tree they keep the slot.
    const flat = limits !== undefined && !hasTreeSlotContext(limits.renderContext);
    const status = args.groupStatusByKey.get(groupKey);
    const groupLoaded = !status || status.state === 'ready';
    // Nothing to list: no sessions, no folders, and no loading or failure
    // line to show.
    const empty = sourceNodes.length === 0
      && groupLoaded
      && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
    if (!hideHeader) {
      const allSessions = indexed.preorderIds.flatMap((id) => indexed.sessionsById.get(id) ?? []);
      push({ kind: 'group-header', key: `${groupKey}:header`, estimateSize: HEADER_ESTIMATE, group, groupKey, projectId, collapsed: storedCollapsed && !empty, forceExpanded: search, empty, allSessions: Object.freeze(allSessions) });
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
      const folderKey = `${groupKey}:folder:${identity}`;
      // An empty folder is always open, so the first session moved in shows.
      // Until the group's sessions have loaded, a folder only looks empty.
      const folderEmpty = groupLoaded && entry.nodes.length === 0 && (childFolders.get(identity)?.length ?? 0) === 0;
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
      appendSessions({ nodes: entry.nodes, containerKey: folderKey, projectId, groupDirectory: entry.scopeDirectory ?? group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth + 1 });
      for (const child of childFolders.get(identity) ?? []) appendFolder(child, displayName);
    };
    for (const folder of roots) appendFolder(folder, '');

    const initialLimit = limits?.initial ?? SESSIONS_INITIAL_LIMIT;
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(groupKey) ?? initialLimit);
    // Pinned sessions are the user's own always-on shortlist: they stay
    // visible whatever the reveal limit is, and they do not spend it.
    const isPinnedNode = (entry: SidebarEntry): boolean => !isRunEntry(entry) && limits?.pinnedAlwaysVisible === true
      && isSessionPinned(pinned, entry.session.directory ?? group.directory, entry.session.id);
    // A run spends one slot of the reveal limit, whatever its lane count.
    const ungroupedEntries = collapseRunEntries(ungrouped, runIndex, group.isArchivedBucket === true);
    const isAlwaysVisible = (entry: SidebarEntry): boolean => isPinnedNode(entry) || holdsCurrentSession(entry);
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
    const visibleUngrouped = visibleEntries.flatMap((entry) => isRunEntry(entry) ? entry.lanes : [entry]);
    appendSessions({ nodes: visibleUngrouped, containerKey: groupKey, projectId, groupDirectory: group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: limits?.renderContext ?? 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth });
    const remaining = ungroupedEntries.length - visibleEntries.length;
    if (!search && !group.isArchivedBucket && remaining > 0) {
      push({ kind: 'show-control', key: `${groupKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey: groupKey, depth: contentDepth, flat });
    } else if (!search && !group.isArchivedBucket && limitedNodes.length > initialLimit && remaining === 0) {
      push({ kind: 'show-control', key: `${groupKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey: groupKey, depth: contentDepth, flat });
    }

    // An empty group lists nothing: its header has no chevron, and new
    // sessions start from the header's own button. Only the archive bucket
    // says it is empty.
    if (sourceNodes.length === 0 && visibleFolders.length === 0) {
      if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, flat });
      else if (group.isArchivedBucket) push({ kind: 'empty', key: `${groupKey}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'archived', depth: contentDepth });
    } else if (status && status.state !== 'ready' && status.state !== 'loading') {
      push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, flat });
    }
  };

  // `forceOpen`: the zone is the whole list (a status filter), so it cannot collapse.
  const appendActivityHeader = (activityKey: SessionSidebarActivityKey, forceOpen = false, count?: number): boolean => {
    const collapsed = !search && !forceOpen && args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: HEADER_ESTIMATE, activityKey, collapsed, forceExpanded: search || forceOpen, count });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'activity', id: activityKey }));
    return collapsed;
  };

  const timelineMode = args.viewMode === 'timeline';

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

  const appendActivityItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
    countMatches: (item: SessionSidebarActivityItem) => number = () => 1,
  ): void => {
    for (const entry of collapseActivityItems(items)) {
      if (isActivityRunEntry(entry)) {
        appendActivityRun(entry, containerKey, renderContext);
        if (search) searchMatchCount += entry.items.reduce((total, item) => total + countMatches(item), 0);
        continue;
      }
      const item = entry;
      const indexed = indexNodes([item.node]);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      const ownerKey = getSessionFolderOwnerKey(item.projectId, item.groupDirectory);
      appendSessions({
        nodes: [item.node], containerKey, projectId: item.projectId, groupDirectory: item.groupDirectory,
        // In work and the timeline lists carry no selection scope.
        ownerKey, selectionScopeKey: null, archived: false, renderContext,
        blockingBadgeSessionScopes: item.blockingBadgeSessionScopes,
        secondaryMeta: item.secondaryMeta, getSecondaryMeta: item.getSecondaryMeta, indexedNodes: indexed, selectionPoolOffset,
      });
      if (search) searchMatchCount += countMatches(item);
    }
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
   * spends one slot; search lists everything.
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

  // Pinned and In work list sessions of every project together: two-line
  // rows with the project's icon in List, one-line rows in Tree unless the
  // user asked for detailed rows.
  const zoneRenderContext: SessionSidebarRenderContext = timelineMode || args.detailedZoneRows ? 'timeline-mixed' : 'mixed-compact';
  const countZoneMatches = (item: SessionSidebarActivityItem): number => (
    item.searchMatchCount ?? countSessionTreeQueryMatches(item.node, args.normalizedQuery)
  );

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
          appendActivityItems(visible, containerKey, 'project', countZoneMatches);
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
      if (pending.length > 0) appendActivityItems(pending, containerKey, zoneRenderContext, countZoneMatches);
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
        appendActivityItems(items, `activity:${filterKey}`, zoneRenderContext, countZoneMatches);
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

  if (hosts) {
    const attentionItems = args.attentionItems ?? [];
    const remoteAttention = hosts.attention.filter(matchesQuery);
    const attentionCount = attentionItems.length + remoteAttention.length;
    if (attentionCount > 0 && !appendActivityHeader('attention', false, attentionCount)) {
      appendMergedZone(hosts, attentionItems, remoteAttention, 'activity:attention');
    }
    const workItems = args.workItems ?? [];
    const remoteWork = hosts.work.filter(matchesQuery);
    if (workItems.length + remoteWork.length > 0 && !appendActivityHeader('work')) {
      appendMergedZone(hosts, workItems, remoteWork, 'activity:work');
    }
    appendHostLists(hosts, new Set([
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
        appendActivityItems(attentionItems, 'activity:attention', zoneRenderContext, countZoneMatches);
      } else {
        appendRevealedItems(attentionItems, 'activity:attention', zoneRenderContext, ATTENTION_INITIAL_LIMIT);
      }
    }
  }

  // This window's host: Chats, Pinned, In work, then the projects.
  const appendLocalContent = (): void => {
    if (args.chatGroup) {
      if (!search || groupSearchMatches(args.chatGroup) > 0) {
        const collapsed = appendActivityHeader('chats');
        if (!collapsed) {
          // Chats are one-line rows in both views, on a short page that pinned
          // chats do not spend; Tree gives them its state slot.
          appendGroup(args.chatGroup, 'activity:chats', null, true, {
            initial: CHATS_INITIAL_LIMIT, pinnedAlwaysVisible: true,
            renderContext: timelineMode ? 'timeline-chat' : 'tree-chat',
          });
        }
      }
    }

    // Pinned and then In work sit under Chats and above the projects. A tree
    // is listed for its matching subsession too; the ancestors around it are
    // context, so only real matches count.
    const appendZone = (activityKey: 'pinned' | 'work', items: readonly SessionSidebarActivityItem[]): void => {
      if (items.length === 0) return;
      const collapsed = appendActivityHeader(activityKey);
      if (!collapsed) appendActivityItems(sortZoneItems(items), `activity:${activityKey}`, zoneRenderContext, countZoneMatches);
    };
    appendZone('pinned', args.pinnedItems ?? []);
    appendZone('work', args.workItems ?? []);

    if (timelineMode) {
      // One header per project, in the user's manual order, over its root
      // sessions from every worktree in lifecycle order. A session the Pinned
      // zone lists is left out of its project here; In work keeps it in both.
      const pinnedZoneIds = new Set((args.pinnedItems ?? []).map((item) => item.node.session.id));
      const itemsByProject = new Map<string, SessionSidebarActivityItem[]>();
      for (const item of args.timelineItems ?? []) {
        if (!item.projectId || isMovedToZone(item.node.session.id) || pinnedZoneIds.has(item.node.session.id)) continue;
        const list = itemsByProject.get(item.projectId);
        if (list) list.push(item);
        else itemsByProject.set(item.projectId, [item]);
      }
      for (const section of args.sections) {
        const projectId = section.project.id;
        const items = itemsByProject.get(projectId) ?? [];
        if (search && items.length === 0) continue;
        const collapsed = !search && args.collapsedProjects.has(projectId);
        const rowIndex = rows.length;
        push({ kind: 'project-header', key: `project:${projectId}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed, forceExpanded: search });
        stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: projectId }));
        if (collapsed) continue;
        // A space without chats has no row of its own here, so its group header
        // stands in for it, with the space's state, until its first chat
        // (journey step 2: the space shows under its project at once).
        if (!search) {
          for (const group of section.groups) {
            if (!group.space || group.sessions.length > 0) continue;
            const groupKey = `${projectId}:${group.id}`;
            // While its chats load the space may well have some; a failed load
            // shows its line, as in the Tree, never an empty space.
            const status = args.groupStatusByKey.get(groupKey);
            if (status?.state === 'loading') continue;
            const empty = (!status || status.state === 'ready')
              && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
            // Forced open: it hides nothing and, like every List row, is not dragged.
            push({ kind: 'group-header', key: `${groupKey}:header`, estimateSize: HEADER_ESTIMATE, group, groupKey, projectId, collapsed: false, forceExpanded: true, empty, allSessions: Object.freeze([]) });
            if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, flat: true });
          }
        }
        if (items.length > 0) {
          appendRevealedItems(items, timelineProjectContainerKey(projectId), 'timeline', SESSIONS_INITIAL_LIMIT);
          continue;
        }
        const mainGroup = section.groups.find((group) => group.isMain);
        if (!mainGroup) continue;
        const groupKey = `${projectId}:${mainGroup.id}`;
        const status = args.groupStatusByKey.get(groupKey);
        if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group: mainGroup, groupKey, flat: true });
      }
    }

    let projectSections = timelineMode ? [] : args.singleProjectMode
      ? args.sections.filter((section) => section.project.id === args.singleProjectId)
      : [...args.sections];
    if (args.showOnlyMainWorkspace) {
      const active = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
      projectSections = active ? [active] : [];
    }
    for (const section of projectSections) {
      const descriptors = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: args.showOnlyMainWorkspace });
      // A project whose only matches moved to a zone shows no empty header.
      if (search && !descriptors.some((descriptor) => groupSearchMatches(descriptor.group) > 0)) continue;
      const projectCollapsed = !search && !args.singleProjectMode && !args.showOnlyMainWorkspace && args.collapsedProjects.has(section.project.id);
      if (!args.showOnlyMainWorkspace) {
        const rowIndex = rows.length;
        push({ kind: 'project-header', key: `project:${section.project.id}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed: projectCollapsed, forceExpanded: search });
        stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: section.project.id }));
      }
      if (projectCollapsed) continue;
      for (const descriptor of descriptors) appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel);
    }

  };

  appendLocalContent();
  appendScheduledZone([]);

  if (rows.length === 0) {
    push({ kind: 'empty', key: search ? 'sidebar:search-empty' : 'sidebar:empty', estimateSize: 72, emptyKind: search ? 'search' : 'sidebar' });
  }
  return finishModel();
};

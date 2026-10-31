import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, countSessionSearchMatches, resolveSessionSidebarStickyHeader, runExpansionKey, SIDEBAR_ACTIVITY_KEYS, type SessionSidebarActivityItem, type SessionSidebarHosts, type SessionSidebarRowModelArgs, type SessionSidebarWorkEntry } from './sessionSidebarRowModel';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { revealAllSessions } from './sessionSidebarReveal';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { HostConnection, HostDescriptor, HostSessionSummary } from '@/lib/hosts/types';
import { projectMonitoredHost } from './hosts/remoteHostProjection';
import type { HostSessionEntry } from './hosts/hostSessionList';

const timelineItem = (id: string, overrides: Partial<SessionSidebarActivityItem> = {}): SessionSidebarActivityItem => ({
  node: { session: session(id), children: [], worktree: null },
  projectId: 'project-a',
  groupDirectory: '/repo',
  secondaryMeta: { projectLabel: 'repo', branchLabel: 'main' },
  ...overrides,
});

const sessionWorks = (items: SessionSidebarActivityItem[]): SessionSidebarWorkEntry[] => items.map((item) => ({ kind: 'session', item }));

const pinnedIds = (...ids: string[]): Set<string> => new Set(
  ids.flatMap((id) => {
    const key = getPinnedSessionKey(getRuntimeKey(), '/repo', id);
    return key ? [key] : [];
  }),
);

// SAFETY: the row model only reads the supplied session identity, title, directory, parent, and lifecycle fields.
const session = (id: string, parentID?: string): Session => ({
  id,
  title: id,
  directory: '/repo',
  parentID,
  time: { created: 1, updated: 1 },
} as Session);

const node = (id: string, children: SessionNode[] = []): SessionNode => ({ session: session(id), children, worktree: null });

const group = (sessions: SessionNode[], overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id: 'main',
  label: 'main',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: '/repo',
  folderScopeKey: '/repo',
  sessions,
  ...overrides,
});

const project = (groups: SessionGroup[]): ProjectSection => ({
  project: { id: 'project-a', normalizedPath: '/repo' },
  groups,
});

const args = (sections: ProjectSection[]): SessionSidebarRowModelArgs => ({
  mode: 'normal',
  sections,
  authoritativeSections: sections,
  chatGroup: null,
  foldersMap: {},
  groupSearchDataByGroup: new WeakMap(),
  normalizedQuery: '',
  collapsedProjects: new Set(),
  collapsedGroups: new Set(),
  collapsedFolders: new Set(),
  collapsedActivities: new Set(),
  expandedParents: new Set(),
  visibleCountByContainer: new Map(),
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
  groupStatusByKey: new Map(),
  folderAuthorityByOwner: new Map([['project-a', { scopeKeys: ['/repo'], complete: true }]]),
  activeProjectId: 'project-a',
  singleProjectMode: false,
  singleProjectId: null,
  showOnlyMainWorkspace: false,
  hideDirectoryControls: false,
});

describe('buildSessionSidebarRowModel', () => {
  test('a session in work is in the top block and stays in its project group', () => {
    const working = node('working');
    const other = node('other');
    const input = args([project([group([working, other])])]);
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);

    const model = buildSessionSidebarRowModel(input);
    const sessionRows = model.rows.flatMap((row) => (row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`] : []));

    expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'work' });
    expect(sessionRows).toEqual(['mixed-compact:working', 'project:other', 'project:working']);
    expect(model.selectionEntries.filter((entry) => entry.id === 'working')).toHaveLength(2);
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
  });

  test('detailed zone rows give the Tree view the two-line row', () => {
    const input = args([project([group([node('working')])])]);
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);
    input.detailedZoneRows = true;

    const rows = buildSessionSidebarRowModel(input).rows;
    const zoneRow = rows.find((row) => row.kind === 'session');

    expect(zoneRow?.kind === 'session' && zoneRow.renderContext).toBe('timeline-mixed');
  });

  test('Pinned opens above In work and its sessions stay in their project', () => {
    const input = args([project([group([node('pinned'), node('working')])])]);
    input.pinnedItems = [timelineItem('pinned')];
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['pinned', 'working']);

    const rows = buildSessionSidebarRowModel(input).rows;
    const order = rows.flatMap((row) => (
      row.kind === 'activity-header' ? [row.activityKey]
        : row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`]
          : []
    ));

    expect(order).toEqual(['pinned', 'mixed-compact:pinned', 'work', 'mixed-compact:working', 'project:pinned', 'project:working']);
  });

  test('search lists a pinned session once, in Pinned', () => {
    const pinnedNode = node('ses_pinned');
    const main = group([pinnedNode, node('ses_other')]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_pinned';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [pinnedNode],
      matchedSessionCount: countSessionSearchMatches([pinnedNode], 'ses_pinned'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    input.pinnedItems = [{ ...timelineItem('ses_pinned'), node: pinnedNode }];
    input.zoneSessionIds = new Set(['ses_pinned']);

    const model = buildSessionSidebarRowModel(input);

    expect(model.searchMatchCount).toBe(1);
    expect(model.rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? ['project'] : []))).toEqual(['pinned']);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(1);
  });

  test('a session in work stays in its folder', () => {
    const input = args([project([group([node('in-folder'), node('top-level')])])]);
    input.foldersMap = { '/repo': [{ id: 'outer', name: 'Outer', createdAt: 1, sessionIds: ['in-folder'] }] };
    input.workEntries = sessionWorks([timelineItem('in-folder')]);
    input.zoneSessionIds = new Set(['in-folder']);

    const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'folder-header' || row.kind === 'session');

    expect(rows.map((row) => (row.kind === 'session' ? `${row.renderContext}:${row.node.session.id}` : row.displayName))).toEqual([
      'mixed-compact:in-folder', 'Outer', 'project:in-folder', 'project:top-level',
    ]);
  });

  test('search lists a session in work once, in the work block, and counts the tree once', () => {
    const parent = node('ses_parent', [node('ses_child'), node('ses_other')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: countSessionSearchMatches([parent], 'ses_child'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));

    expect(model.searchMatchCount).toBe(1);
    expect(rows).toEqual(['ses_parent']);
    expect(model.selectionEntries.filter((entry) => entry.id === 'ses_parent')).toHaveLength(1);
  });

  test('rows carry guide lines for an open worktree and session', () => {
    const parent = node('parent', [node('child')]);
    const worktree = group([parent, node('last')], { id: 'wt', label: 'wt', isMain: false, directory: '/wt' });
    const input = args([project([group([node('root')]), worktree])]);
    input.expandedParents = new Set(['project:active:parent']);
    input.sessionOrderIndex = new Map([['root', 0], ['parent', 1], ['last', 2]]);
    const guidesOf = () => buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'session' ? [`${row.node.session.id}:${(row.treeGuides ?? []).map(({ level, end }) => `${level}${end ? '└' : '│'}`).join(' ')}`] : []
    ));

    expect(guidesOf()).toEqual(['root:', 'parent:1│', 'child:1│ 2└', 'last:1└']);
  });

  test('search counts a subsession of a session in work once, and the moved tree leaves its group', () => {
    const parent = node('ses_parent', [node('ses_child'), node('ses_other')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: countSessionSearchMatches([parent], 'ses_child'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    // As the sidebar builds it: the zone row drops its children and carries
    // the count of its whole tree.
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));

    expect(model.searchMatchCount).toBe(1);
    expect(rows).toEqual(['ses_parent']);
    // The project had no other match: no empty project header.
    expect(model.rows.some((row) => row.kind === 'project-header')).toBe(false);
  });

  test('search counts every matching subsession of a session in work', () => {
    const titled = (id: string, title: string, children: SessionNode[] = []): SessionNode => ({ session: { ...session(id), title }, children, worktree: null });
    const parent = titled('ses_parent', 'Parent', [titled('ses_a', 'fix header'), titled('ses_b', 'header spacing'), titled('ses_c', 'footer')]);
    const input = args([]);
    input.mode = 'search';
    input.normalizedQuery = 'header';
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), node: { ...parent, children: [] }, searchMatchCount: countSessionTreeQueryMatches(parent, 'header') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    expect(buildSessionSidebarRowModel(input).searchMatchCount).toBe(2);
  });

  test('in work sits under Chats and above the projects', () => {
    const working = node('working');
    const input = args([project([group([working, node('other')])])]);
    input.chatGroup = group([node('chat')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);

    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? [row.section.project.id] : []
    ));

    expect(headers).toEqual(['chats', 'work', 'project-a']);
  });

  test('no block while nothing is in work', () => {
    const input = args([project([group([node('other')])])]);
    input.workEntries = sessionWorks([]);
    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : []));
    expect(headers).not.toContain('work');
  });

  test('uses occurrence keys while retaining duplicate session IDs in logical order', () => {
    const repeated = node('same-session');
    const input = args([project([group([repeated])])]);
    input.workEntries = sessionWorks([{ node: repeated, projectId: 'project-a', groupDirectory: '/repo', secondaryMeta: null }]);
    input.zoneSessionIds = new Set(['same-session']);

    const model = buildSessionSidebarRowModel(input);
    const entries = model.selectionEntries.filter((entry) => entry.id === 'same-session');

    expect(entries).toHaveLength(2);
    expect(entries[0]?.rowKey).not.toBe(entries[1]?.rowKey);
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
  });

  test('forces descendants open in search without changing persisted expansion state', () => {
    const parent = node('parent', [node('child')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: 1,
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['parent', 'child']);
    const parentEntry = model.selectionEntries.find((entry) => entry.id === 'parent');
    expect(parentEntry?.descendantRange).toBeDefined();
    expect(parentEntry?.descendantRange
      ? model.selectionDescendantIds.slice(parentEntry.descendantRange[0], parentEntry.descendantRange[1])
      : []).toEqual(['child']);
    expect(input.expandedParents.size).toBe(0);
  });

  test('enables folder drops only when the owner scope set is authoritative', () => {
    const main = group([node('session-a')]);
    const input = args([project([main])]);
    input.foldersMap = { '/repo': [{ id: 'folder-a', name: 'Folder', sessionIds: ['session-a'], createdAt: 1 }] };

    expect(buildSessionSidebarRowModel(input).folderDropTargets[0]?.enabled).toBe(true);

    input.folderAuthorityByOwner = new Map([['project-a', { scopeKeys: ['/repo'], complete: false }]]);
    expect(buildSessionSidebarRowModel(input).folderDropTargets[0]?.enabled).toBe(false);
  });

  test('keeps a 25,000-session group bounded until show-more is requested', () => {
    const sessions = Array.from({ length: 25_000 }, (_, index) => node(`session-${index}`));
    const model = buildSessionSidebarRowModel(args([project([group(sessions)])]));

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(3);
    expect(model.rows.some((row) => row.kind === 'show-control' && row.control === 'more')).toBe(true);
  });

  test('Chats keep the tree slot', () => {
    const input = args([]);
    input.chatGroup = group(Array.from({ length: 5 }, (_, index) => node(`chat-${index}`)), { id: 'managed-chats' });
    const rows = buildSessionSidebarRowModel(input).rows;

    expect([...new Set(rows.flatMap((row) => (row.kind === 'session' ? [row.renderContext] : [])))]).toEqual(['tree-chat']);
    expect(rows.find((row) => row.kind === 'show-control')).toMatchObject({ flat: false });
  });

  test('Chats failure stays visible beside retained sessions', () => {
    const input = args([]);
    input.chatGroup = group([node('retained-chat')], { id: 'managed-chats' });
    input.groupStatusByKey = new Map([['activity:chats', { state: 'load-failed', directory: '/chats', canGrantAccess: false }]]);
    const rows = buildSessionSidebarRowModel(input).rows;
    expect(rows.some((row) => row.kind === 'session' && row.node.session.id === 'retained-chat')).toBe(true);
    expect(rows.find((row) => row.kind === 'status')).toMatchObject({ groupKey: 'activity:chats', status: { state: 'load-failed' } });
    expect(rows.some((row) => row.kind === 'empty')).toBe(false);
  });

  test('a collapsed folder retains activity coverage from nested folders without flattening subtasks', () => {
    const child = node('child');
    child.session.parentID = 'parent';
    const parent = node('parent', [child]);
    const input = args([project([group([parent])])]);
    input.foldersMap = { '/repo': [
      { id: 'outer', name: 'Outer', createdAt: 1, sessionIds: [] },
      { id: 'inner', name: 'Inner', parentId: 'outer', createdAt: 1, sessionIds: ['parent', 'child'] },
    ] };
    input.collapsedFolders = new Set(['outer']);
    const model = buildSessionSidebarRowModel(input);
    const folder = model.rows.find((row) => row.kind === 'folder-header');
    if (!folder || folder.kind !== 'folder-header') throw new Error('Missing outer folder');
    expect(folder.nodes).toEqual([]);
    expect(folder.activityNodes).toEqual([parent]);
    expect(folder.activityNodes[0]?.children).toEqual([child]);
    expect(model.rows.filter((row) => row.kind === 'folder-header')).toHaveLength(1);
    expect(model.rows.some((row) => row.kind === 'session')).toBe(false);
  });

  test('sessions inside a folder sit one level deeper than ungrouped sessions', () => {
    const child = node('child');
    child.session.parentID = 'in-folder';
    const input = args([project([group([node('in-folder', [child]), node('top-level')])])]);
    input.foldersMap = { '/repo': [
      { id: 'outer', name: 'Outer', createdAt: 1, sessionIds: [] },
      { id: 'inner', name: 'Inner', parentId: 'outer', createdAt: 1, sessionIds: ['in-folder'] },
    ] };
    input.expandedParents = new Set(['project:active:in-folder']);
    const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'folder-header' || row.kind === 'session');

    expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : row.displayName))).toEqual([
      'Outer', 'Outer / Inner', 'in-folder@1', 'child@2', 'top-level@0',
    ]);
  });

  test('builds the folder-heavy 25,000-session projection without duplicating descendant storage', () => {
    const sessions = Array.from({ length: 25_000 }, (_, index) => node(`session-${index}`));
    const input = args([project([group(sessions)])]);
    input.foldersMap = {
      '/repo': Array.from({ length: 1_250 }, (_, folderIndex) => ({
        id: `folder-${folderIndex}`,
        name: `Folder ${folderIndex}`,
        createdAt: folderIndex,
        sessionIds: Array.from({ length: 20 }, (_, itemIndex) => `session-${folderIndex * 20 + itemIndex}`),
      })),
    };

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows.filter((row) => row.kind === 'folder-header')).toHaveLength(1_250);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(25_000);
    expect(model.selectionDescendantIds).toHaveLength(25_000);
    expect(model.rows).toHaveLength(26_251);
  });

  test('keeps normal activity state while search forces the same headers open', () => {
    const repeated = node('recent-match');
    const normal = args([]);
    normal.chatGroup = group([repeated], { id: 'managed-chats' });
    normal.collapsedActivities = new Set(['chats']);
    const normalModel = buildSessionSidebarRowModel(normal);

    const search = { ...normal, mode: 'search' as const, normalizedQuery: 'recent' };
    search.groupSearchDataByGroup = new WeakMap([[search.chatGroup!, {
      filteredNodes: [repeated], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true,
    }]]);
    const searchModel = buildSessionSidebarRowModel(search);

    expect(normalModel.rows.find((row) => row.kind === 'activity-header')).toMatchObject({ collapsed: true, forceExpanded: false });
    expect(searchModel.rows.find((row) => row.kind === 'activity-header')).toMatchObject({ collapsed: false, forceExpanded: true });
    expect(normal.collapsedActivities.has('chats')).toBe(true);
  });

  test('emits loading, failure, and permission status rows without treating them as empty success', () => {
    for (const state of ['loading', 'load-failed', 'permission-denied'] as const) {
      const main = group([]);
      const input = args([project([main])]);
      input.groupStatusByKey = new Map([['project-a:main', { state, directory: '/repo', canGrantAccess: state === 'permission-denied' }]]);
      expect(buildSessionSidebarRowModel(input).rows.some((row) => row.kind === 'status' && row.status.state === state)).toBe(true);
    }
  });

  test('resolves sticky identity from logical row ranges', () => {
    const first = project([group([node('a')])]);
    const second = { ...project([group([node('b')])]), project: { id: 'project-b', normalizedPath: '/repo-b' } };
    const model = buildSessionSidebarRowModel(args([first, second]));
    const secondHeader = model.stickyHeaders.find((header) => header.id === 'project-b');

    expect(secondHeader).toBeDefined();
    expect(resolveSessionSidebarStickyHeader(model.stickyHeaders, secondHeader?.rowIndex ?? 0)?.id).toBe('project-b');
  });

  {
    test('Chats reveal three chats and never count pinned chats against that limit', () => {
      const chats = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 6 }, (_, index) => node(`chat-${index}`))];
      const input = args([]);
      input.chatGroup = group(chats, { id: 'managed-chats' });
      input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

      const model = buildSessionSidebarRowModel(input);
      const shown = model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id);

      expect(shown).toContain('pinned-1');
      expect(shown).toContain('pinned-2');
      expect(shown.filter((id) => id.startsWith('chat-'))).toHaveLength(3);
      const control = model.rows.find((row) => row.kind === 'show-control');
      expect(control).toMatchObject({ control: 'more', containerKey: 'activity:chats' });

      input.visibleCountByContainer = revealAllSessions(input.visibleCountByContainer, 'activity:chats');
      const revealed = buildSessionSidebarRowModel(input).rows;
      expect(revealed.filter((row) => row.kind === 'session')).toHaveLength(8);
      expect(revealed.find((row) => row.kind === 'show-control')).toMatchObject({ control: 'fewer' });
    });
  }

  test('pinned project sessions spend the reveal limit', () => {
    const nodes = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 8 }, (_, index) => node(`s${index}`))];
    const input = args([project([group(nodes)])]);
    input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session')).toHaveLength(3);
  });

  test('the open session stays listed beyond the reveal limit without spending it', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => node(`s${index}`));
    const input = args([project([group(nodes)])]);
    input.currentSessionId = 's8';

    const shown = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));
    expect(shown).toHaveLength(4);
    expect(shown).toContain('s8');
  });

  test('an empty worktree group is open whatever was saved, with no rows under it', () => {
    const worktree = group([], { id: 'worktree:/wt', label: 'feature', isMain: false, directory: '/wt', folderScopeKey: '/wt' });
    const input = args([project([group([node('root')]), worktree])]);
    input.collapsedGroups = new Set(['project-a:worktree:/wt']);

    const rows = buildSessionSidebarRowModel(input).rows;
    const header = rows.find((row) => row.kind === 'group-header');

    expect(header).toMatchObject({ empty: true, collapsed: false });
    expect(rows.at(-1)).toBe(header);
  });

  test('a worktree group with sessions keeps its saved collapse', () => {
    const worktree = group([node('wt-session')], { id: 'worktree:/wt', label: 'feature', isMain: false, directory: '/wt', folderScopeKey: '/wt' });
    const input = args([project([group([]), worktree])]);
    input.collapsedGroups = new Set(['project-a:worktree:/wt']);

    const rows = buildSessionSidebarRowModel(input).rows;

    expect(rows.find((row) => row.kind === 'group-header')).toMatchObject({ empty: false, collapsed: true });
    expect(rows.some((row) => row.kind === 'session')).toBe(false);
  });

  test('a folder keeps its saved collapse while its sessions are still loading', () => {
    const input = args([project([group([])])]);
    input.foldersMap = { '/repo': [{ id: 'outer', name: 'Outer', createdAt: 1, sessionIds: ['not-loaded-yet'] }] };
    input.collapsedFolders = new Set(['outer']);
    const folderRow = () => buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'folder-header');

    input.groupStatusByKey = new Map([['project-a:main', { state: 'loading', directory: null, canGrantAccess: false }]]);
    expect(folderRow()).toMatchObject({ empty: false, collapsed: true });

    input.groupStatusByKey = new Map([['project-a:main', { state: 'ready', directory: '/repo', canGrantAccess: false }]]);
    expect(folderRow()).toMatchObject({ empty: true, collapsed: false });
  });

  describe('works', () => {
    const worktree = (sessions: SessionNode[], id = 'wt') => group(sessions, {
      id: `worktree:/${id}`, label: id, branch: `feature/${id}`, isMain: false, directory: `/${id}`, folderScopeKey: `/${id}`,
      worktree: { path: `/${id}`, projectDirectory: '/repo', branch: `feature/${id}`, label: id },
    });
    const listedOf = (rows: ReturnType<typeof buildSessionSidebarRowModel>['rows']) => rows.flatMap((row) => (
      row.kind === 'activity-header' ? [`zone:${row.activityKey}`]
        : row.kind === 'project-header' ? [`project:${row.section.project.id}`]
          : row.kind === 'group-header' ? [`work:${row.group.id}@${row.depth}${row.mixed ? ':mixed' : ''}`]
            : row.kind === 'folder-header' ? [`folder:${row.displayName}`]
              : row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}@${row.depth}`]
                : []
    ));

    test('a worktree is listed among the project root works at the place of its latest session, spending one slot', () => {
      // Order: wt-new (in the worktree) is the most recent session, then root-a,
      // then wt-old (an older session in that worktree's tree), then root-b.
      const work = worktree([node('wt-old', [node('wt-new')])]);
      const roots = Array.from({ length: 8 }, (_, index) => node(`r${index}`));
      const input = args([project([group(roots), work])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['wt-new', 1], ['wt-old', 9], ...roots.slice(1).map((root, index) => [root.session.id, index + 2] as const)]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);

      const listed = listedOf(buildSessionSidebarRowModel(input).rows);
      expect(listed).toEqual([
        'project:project-a', 'project:r0@0', 'work:worktree:/wt@0',
        'project:r1@0',
      ]);
    });

    test('a space nobody has chatted in leads its project list, where an empty worktree closes it past Show more', () => {
      const space = group([], {
        id: 'space:0123456789ab', label: 'quick-falcon', isMain: false, directory: '/spaces/0123456789ab/repo', folderScopeKey: '/spaces/0123456789ab/repo',
        space: { id: '0123456789ab', name: 'quick-falcon', state: 'complete', projectDirectory: '/repo', directory: '/spaces/0123456789ab/repo' },
      });
      const roots = Array.from({ length: 8 }, (_, index) => node(`r${index}`));
      const input = args([project([group(roots), worktree([], 'empty'), space])]);
      input.sessionOrderIndex = new Map(roots.map((root, index) => [root.session.id, index] as const));
      input.liveSpaceIds = new Set(['0123456789ab']);

      const listed = listedOf(buildSessionSidebarRowModel(input).rows);
      expect(listed.slice(0, 3)).toEqual(['project:project-a', 'work:space:0123456789ab@0', 'project:r0@0']);
      expect(listed).not.toContain('work:worktree:/empty@0');

      // Failed or gone, it closes the list as an empty worktree does.
      input.liveSpaceIds = new Set();
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).not.toContain('work:space:0123456789ab@0');
    });

    test('Detailed rows give the works under a project two lines, and keep what nests inside them on one', () => {
      const work = worktree([node('wt-1')]);
      const input = args([project([group([node('root', [node('child')])]), work])]);
      input.detailedZoneRows = true;
      input.expandedParents = new Set(['project:active:root']);
      input.draftsByGroupKey = new Map([
        ['project-a:main', [{ id: 'd1', directory: '/repo', projectId: 'project-a', text: 'next', mentions: [], attachments: [], createdAt: 1, updatedAt: 1 }]],
      ]);

      const detailedOf = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
        row.kind === 'session' ? [`${row.node.session.id}:${row.detailed === true}`]
          : row.kind === 'draft' ? [`draft:${row.detailed}`]
            : row.kind === 'group-header' ? [`work:${row.detailed}`]
              : []
      ));
      expect(detailedOf).toEqual(['draft:true', 'root:true', 'child:false', 'work:true', 'wt-1:false']);
    });

    test('only the rows that are works of their own own their work', () => {
      const work = worktree([node('wt-1', [node('wt-child')])]);
      const input = args([project([group([node('root', [node('child')]), node('lane-1'), node('lane-2')]), work])]);
      input.runIndex = buildMultiRunIndex(['lane-1', 'lane-2'].map((id) => ({
        ...session(id),
        metadata: withMultiRunMembership({}, {
          version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
          groupSlug: 'fix-auth', role: 'run', providerID: 'anthropic', modelID: 'claude', title: 'Fix auth',
        }),
      })), () => '/repo');
      const runKey = [...input.runIndex.runs.keys()][0] ?? '';
      input.expandedParents = new Set(['mixed-compact:active:root', 'project:active:root', 'project:active:wt-1', runExpansionKey('project', runKey)]);
      input.workEntries = sessionWorks([timelineItem('root', { node: node('root', [node('child')]) })]);
      input.zoneSessionIds = new Set(['root', 'child']);

      const owners = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
        row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}:${row.ownsWork}`] : []
      ));
      expect(owners).toEqual([
        'mixed-compact:root:true', 'mixed-compact:child:false',
        'project:lane-1:false', 'project:lane-2:false',
        'project:root:true', 'project:child:false',
        'project:wt-1:false', 'project:wt-child:false',
      ]);
    });

    test('a worktree stands where its archived sessions hold it', () => {
      const input = args([project([group([node('r0'), node('r1')]), worktree([node('wt-old')])])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['r1', 1], ['wt-old', 2]]);
      input.worktreeArchiveAnchors = new Map([['project-a:worktree:/wt', 0.5]]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:r0@0', 'work:worktree:/wt@0', 'project:r1@0']);
    });

    test('a pinned worktree is listed in Pinned after the pinned sessions, and leads its project while the section is hidden', () => {
      const pinnedWork = group([node('a1')], {
        id: 'worktree:/wt', label: 'wt', branch: 'feature/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt',
        worktree: { path: '/wt', projectDirectory: '/repo', branch: 'feature/wt', label: 'wt', pinnedAt: 1 },
      });
      const input = args([project([group([node('r0'), node('pinned')]), pinnedWork])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['a1', 1]]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);
      input.pinnedItems = [timelineItem('pinned')];
      input.pinnedWorktrees = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: pinnedWork }];
      input.movedSessionIds = new Set(['pinned']);
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:pinned', 'mixed-compact:pinned@0', 'work:worktree:/wt@0:mixed', 'project:project-a', 'project:r0@0',
      ]);

      input.pinnedItems = [];
      input.pinnedWorktrees = [];
      input.movedSessionIds = new Set();
      input.movedGroupKeys = new Set();
      expect(listedOf(buildSessionSidebarRowModel(input).rows).slice(0, 3)).toEqual(['project:project-a', 'work:worktree:/wt@0', 'project:r0@0']);
    });

    test('a worktree with no session closes the project root list', () => {
      const input = args([project([group([node('root')]), worktree([])])]);
      input.sessionOrderIndex = new Map([['root', 0]]);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:root@0', 'work:worktree:/wt@0']);
    });

    test('a session work In work lists leaves its project when the collection moves it', () => {
      const input = args([project([group([node('working'), node('other')])])]);
      input.workEntries = sessionWorks([timelineItem('working')]);
      input.zoneSessionIds = new Set(['working']);
      input.movedSessionIds = new Set(['working']);

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:work', 'mixed-compact:working@0', 'project:project-a', 'project:other@0',
      ]);
    });

    test('a worktree work In work lists is its group row naming its project, out of the drag sort, and leaves its project', () => {
      const work = worktree([node('a1'), node('a2')]);
      const input = args([project([group([node('root')]), work])]);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);

      const model = buildSessionSidebarRowModel(input);
      expect(listedOf(model.rows)).toEqual([
        'zone:work', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'project:a2@1', 'project:project-a', 'project:root@0',
      ]);
    });

    test('a worktree work kept in its project too keeps every row key unique and shares its collapse', () => {
      const work = worktree([node('a1')]);
      const input = args([project([group([]), work])]);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);

      const model = buildSessionSidebarRowModel(input);
      const headers = model.rows.filter((row) => row.kind === 'group-header');
      expect(headers.map((row) => row.kind === 'group-header' && `${row.mixed}:${row.collapsed}`)).toEqual(['true:true', 'false:true']);
      expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
    });

    test('the list by time lists the works of every project in one zone, without project headers', () => {
      const work = worktree([node('a1')]);
      const second: ProjectSection = { project: { id: 'project-b', normalizedPath: '/other' }, groups: [group([], { directory: '/other' })] };
      const input = args([project([group([node('root')]), work]), second]);
      input.pinnedItems = [timelineItem('pinned')];
      input.workEntries = sessionWorks([timelineItem('working')]);
      input.timeEntries = [
        { kind: 'session', item: timelineItem('b1', { projectId: 'project-b' }) },
        { kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work },
        { kind: 'session', item: timelineItem('root') },
      ];

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:pinned', 'mixed-compact:pinned@0', 'zone:work', 'mixed-compact:working@0',
        'zone:timeline', 'mixed-compact:b1@0', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'mixed-compact:root@0',
      ]);

      input.collapsedActivities = new Set(['timeline']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows).slice(-1)).toEqual(['zone:timeline']);
    });

    test('the list by time shows one line while sessions load and one per failed directory', () => {
      const second: ProjectSection = { project: { id: 'project-b', normalizedPath: '/other' }, groups: [group([], { directory: '/other' })] };
      const third: ProjectSection = { project: { id: 'project-c', normalizedPath: '/third' }, groups: [group([], { directory: '/third' })] };
      const input = args([project([group([])]), second, third]);
      input.timeEntries = [];
      input.groupStatusByKey = new Map([
        ['project-a:main', { state: 'loading' as const, directory: null, canGrantAccess: false }],
        ['project-b:main', { state: 'loading' as const, directory: null, canGrantAccess: false }],
        ['project-c:main', { state: 'load-failed' as const, directory: '/third', canGrantAccess: false }],
      ]);

      const statusesOf = () => buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'status' ? [`${row.status.state}:${row.groupKey}`] : []));
      expect(statusesOf()).toEqual(['loading:project-a:main', 'load-failed:project-c:main']);

      // A project with listed works needs no line, as under its own header.
      input.timeEntries = sessionWorks([timelineItem('a1')]);
      expect(statusesOf()).toEqual(['loading:project-b:main', 'load-failed:project-c:main']);
    });

    test('single-project mode keeps its project and picker whatever the grouping', () => {
      const input = args([project([group([node('root')])])]);
      input.singleProjectMode = true;
      input.singleProjectId = 'project-a';
      input.timeEntries = sessionWorks([timelineItem('root')]);

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:root@0']);
    });

    test('a worktree filed into a folder of the project root renders inside it, and only there', () => {
      const work = worktree([node('a1')]);
      const input = args([project([group([node('root')]), work])]);
      input.foldersMap = { '/repo': [{ id: 'f', name: 'Releases', createdAt: 1, sessionIds: ['worktree:/wt'] }] };

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'project:project-a', 'folder:Releases', 'work:worktree:/wt@1', 'project:a1@2', 'project:root@0',
      ]);

      // Folded away In work, the folder holds nothing of it.
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:work', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'project:project-a', 'folder:Releases', 'project:root@0',
      ]);
    });
  });

  describe('multi-run rows', () => {
    const runMember = (id: string): Session => ({
      ...session(id),
      metadata: withMultiRunMembership({}, {
        version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
        groupSlug: 'fix-auth', role: 'run', providerID: 'anthropic', modelID: 'claude', title: 'Fix auth',
      }),
    });
    const runIndex = buildMultiRunIndex([runMember('lane-1'), runMember('lane-2')], () => '/repo');
    const runKey = [...runIndex.runs.keys()][0] ?? '';

    test('a run In work lists is one row even when a worktree work sits between its members', () => {
      const work = group([node('wt-1')], {
        id: 'worktree:/wt', label: 'wt', branch: 'feature/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt',
        worktree: { path: '/wt', projectDirectory: '/repo', branch: 'feature/wt', label: 'wt' },
      });
      const input = args([project([group([node('lane-1'), node('lane-2')]), work])]);
      input.runIndex = runIndex;
      input.workEntries = [
        { kind: 'session', item: timelineItem('lane-1') },
        { kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work },
        { kind: 'session', item: timelineItem('lane-2') },
      ];
      input.movedSessionIds = new Set(['lane-1', 'lane-2']);
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      const runRows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run');
      expect(runRows).toHaveLength(1);
      expect(runRows[0]?.kind === 'run' && runRows[0].laneNodes.map((lane) => lane.session.id)).toEqual(['lane-1', 'lane-2']);
    });

    test('lanes collapse into one run row at the first lane, outside selection', () => {
      const input = args([project([group([node('lane-1'), node('other'), node('lane-2')])])]);
      input.runIndex = runIndex;
      const model = buildSessionSidebarRowModel(input);
      const listed = model.rows.flatMap((row) => (row.kind === 'run' ? [`run:${row.run.title}`] : row.kind === 'session' ? [row.node.session.id] : []));

      expect(listed).toEqual(['run:Fix auth', 'other']);
      expect(model.selectionEntries.map((entry) => entry.id)).toEqual(['other']);
    });

    test('an expanded run lists its lanes one level deeper', () => {
      const input = args([project([group([node('lane-1'), node('lane-2')])])]);
      input.runIndex = runIndex;
      input.expandedParents = new Set([runExpansionKey('project', runKey)]);
      const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run' || row.kind === 'session');

      expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : `run@${row.depth}`))).toEqual(['run@0', 'lane-1@1', 'lane-2@1']);
    });

    test('a run inside a folder and its lanes sit one level deeper', () => {
      const input = args([project([group([node('lane-1'), node('lane-2')])])]);
      input.runIndex = runIndex;
      input.foldersMap = { '/repo': [{ id: 'folder-a', name: 'Folder', createdAt: 1, sessionIds: ['lane-1', 'lane-2'] }] };
      input.expandedParents = new Set([runExpansionKey('project', runKey)]);
      const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run' || row.kind === 'session');

      expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : `run@${row.depth}`))).toEqual(['run@1', 'lane-1@2', 'lane-2@2']);
    });

    test('a run spends one slot of the reveal limit', () => {
      const nodes = [node('lane-1'), node('lane-2'), ...Array.from({ length: 7 }, (_, index) => node(`s${index}`))];
      const input = args([project([group(nodes)])]);
      input.runIndex = runIndex;
      const model = buildSessionSidebarRowModel(input);

      expect(model.rows.filter((row) => row.kind === 'run')).toHaveLength(1);
      expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(2);
    });

    test('an In work run row opens to its lanes as one-line rows and carries the sessions that block them', () => {
      const input = args([]);
      input.runIndex = runIndex;
      input.detailedZoneRows = true;
      input.workEntries = sessionWorks([
        timelineItem('lane-1', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-1', 'lane-1-child'] }] }),
        timelineItem('lane-2', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-2'] }] }),
      ]);
      input.zoneSessionIds = new Set(['lane-1', 'lane-2']);
      const run = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'run');
      expect(run?.kind === 'run' && [...run.blockingSessionIds]).toEqual(['lane-1', 'lane-1-child', 'lane-2']);
      expect(run).toMatchObject({ detailed: true, expanded: false });

      input.expandedParents = new Set([runExpansionKey('timeline-mixed', runKey)]);
      const lanes = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'session' ? [`${row.node.session.id}:${row.renderContext}`] : []));
      expect(lanes).toEqual(['lane-1:mixed-compact', 'lane-2:mixed-compact']);
    });

  });

  test('retains current session authority when presentation filters the row out', () => {
    const authoritative = project([group([node('hidden')])]);
    const input = args([]);
    input.authoritativeSections = [authoritative];

    expect(buildSessionSidebarRowModel(input).sessionById.get('hidden')?.id).toBe('hidden');
  });
});

describe('Needs you zone and status filter', () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `ses_wait${index + 1}`);
  const zoneRows = (model: ReturnType<typeof buildSessionSidebarRowModel>) => model.rows.flatMap((row) => {
    if (row.kind === 'activity-header') return [`header:${row.activityKey}`];
    if (row.kind === 'project-header') return [`project:${row.section.project.id}`];
    if (row.kind === 'session') return [`${row.renderContext}:${row.node.session.id}`];
    if (row.kind === 'show-control') return [`${row.control}:${row.containerKey}`];
    if (row.kind === 'empty') return [`empty:${row.emptyKind}`];
    return [];
  });

  test('opens the list above Chats with its count, and its sessions stay in their projects', () => {
    const input = args([project([group([node('waiting'), node('other')])])]);
    input.chatGroup = group([node('chat')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.attentionItems = [timelineItem('waiting')];
    input.zoneSessionIds = new Set(['waiting']);

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'attention', count: 1 });
    expect(zoneRows(model)).toEqual([
      'header:attention', 'mixed-compact:waiting',
      'header:chats', 'tree-chat:chat',
      'project:project-a', 'project:other', 'project:waiting',
    ]);
  });

  test('uses the two-line rows with detailed rows', () => {
    const input = args([project([group([node('waiting')])])]);
    input.detailedZoneRows = true;
    input.attentionItems = [timelineItem('waiting')];
    input.zoneSessionIds = new Set(['waiting']);

    expect(zoneRows(buildSessionSidebarRowModel(input))[1]).toBe('timeline-mixed:waiting');
  });

  test('shows five at first, the rest on Show more, then Show fewer', () => {
    const waiting = ids(30);
    const input = args([project([group([])])]);
    input.attentionItems = waiting.map((id) => timelineItem(id));

    const first = zoneRows(buildSessionSidebarRowModel(input));
    expect(first.filter((row) => row.startsWith('mixed-compact:'))).toEqual(waiting.slice(0, 5).map((id) => `mixed-compact:${id}`));
    expect(first).toContain('more:activity:attention');

    input.visibleCountByContainer = revealAllSessions(input.visibleCountByContainer, 'activity:attention');
    const expanded = zoneRows(buildSessionSidebarRowModel(input));
    expect(expanded.filter((row) => row.startsWith('mixed-compact:'))).toHaveLength(30);
    expect(expanded).toContain('fewer:activity:attention');
  });

  test('collapses from its header and keeps its count, but Collapse all leaves it open', () => {
    const input = args([project([group([node('waiting')])])]);
    input.attentionItems = [timelineItem('waiting')];
    input.collapsedActivities = new Set(['attention']);

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'attention', collapsed: true, count: 1 });
    expect(zoneRows(model)).toEqual(['header:attention', 'project:project-a', 'project:waiting']);
    expect(SIDEBAR_ACTIVITY_KEYS).not.toContain('attention');
  });

  test('search lists every match once, in Needs you, without a reveal limit or a collapse', () => {
    const waiting = ids(7);
    const nodes = waiting.map((id) => node(id));
    const main = group(nodes);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'wait';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: nodes,
      matchedSessionCount: countSessionSearchMatches(nodes, 'wait'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    input.attentionItems = nodes.map((entry) => ({ ...timelineItem(entry.session.id), node: entry }));
    input.zoneSessionIds = new Set(waiting);
    input.collapsedActivities = new Set(['attention']);

    const model = buildSessionSidebarRowModel(input);

    expect(model.searchMatchCount).toBe(7);
    expect(zoneRows(model)).toEqual(['header:attention', ...waiting.map((id) => `mixed-compact:${id}`)]);
  });

  test('the Needs you filter shows only that zone, in full, and it cannot collapse', () => {
    const waiting = ids(7);
    const input = args([project([group([node('other')])])]);
    input.chatGroup = group([node('chat')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.attentionItems = waiting.map((id) => timelineItem(id));
    input.collapsedActivities = new Set(['attention']);
    input.statusFilter = 'attention';

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'attention', collapsed: false, forceExpanded: true, count: 7 });
    expect(zoneRows(model)).toEqual(['header:attention', ...waiting.map((id) => `mixed-compact:${id}`)]);
    expect(model.stickyHeaders).toEqual([{ rowIndex: 0, kind: 'activity', id: 'attention' }]);
  });

  test('the Running filter lists what runs, and says so when nothing does', () => {
    const input = args([project([group([node('running'), node('idle')])])]);
    input.attentionItems = [timelineItem('waiting')];
    input.statusFilter = 'running';
    input.runningItems = [timelineItem('running')];

    expect(zoneRows(buildSessionSidebarRowModel(input))).toEqual(['header:running', 'mixed-compact:running']);

    input.runningItems = [];
    expect(zoneRows(buildSessionSidebarRowModel(input))).toEqual(['empty:running-filter']);

    input.statusFilter = 'attention';
    input.attentionItems = [];
    expect(zoneRows(buildSessionSidebarRowModel(input))).toEqual(['empty:attention-filter']);
  });

  const sortableItem = (id: string, updated: number, created = updated): SessionSidebarActivityItem => {
    const item = timelineItem(id);
    item.node.session = { ...item.node.session, title: id, time: { created, updated } } as Session;
    return item;
  };

  test('without a host list the Needs you zone follows the session sort', () => {
    const input = args([project([group([node('old')])])]);
    input.attentionItems = [sortableItem('b', 1, 30), sortableItem('c', 3, 10), sortableItem('a', 2, 20)];
    const order = (): string[] => zoneRows(buildSessionSidebarRowModel(input)).filter((row) => row.startsWith('mixed-compact'));

    input.sessionSort = 'activity';
    expect(order()).toEqual(['mixed-compact:c', 'mixed-compact:a', 'mixed-compact:b']);
    input.sessionSort = 'created';
    expect(order()).toEqual(['mixed-compact:b', 'mixed-compact:a', 'mixed-compact:c']);
    input.sessionSort = 'name';
    expect(order()).toEqual(['mixed-compact:a', 'mixed-compact:b', 'mixed-compact:c']);
  });

  test('without a host list the status filter zone, Pinned and In work follow the session sort', () => {
    const input = args([project([group([node('old')])])]);
    input.sessionSort = 'name';
    input.runningItems = [sortableItem('z', 5), sortableItem('m', 1)];
    input.statusFilter = 'running';
    expect(zoneRows(buildSessionSidebarRowModel(input))).toEqual(['header:running', 'mixed-compact:m', 'mixed-compact:z']);

    input.statusFilter = 'all';
    input.pinnedItems = [sortableItem('y', 5), sortableItem('x', 1)];
    input.workEntries = sessionWorks([sortableItem('w', 5), sortableItem('v', 1)]);
    const rows = zoneRows(buildSessionSidebarRowModel(input)).filter((row) => row.startsWith('mixed-compact'));
    expect(rows).toEqual(['mixed-compact:x', 'mixed-compact:y', 'mixed-compact:v', 'mixed-compact:w']);
  });

  test('the Status sort ranks the waiting sessions before the running ones', () => {
    const input = args([project([group([node('old')])])]);
    input.sessionSort = 'status';
    input.attentionItems = [sortableItem('waiting', 1)];
    input.runningItems = [sortableItem('running', 5)];
    input.workEntries = sessionWorks([sortableItem('idle', 9), sortableItem('running', 5), sortableItem('waiting', 1)]);
    const rows = zoneRows(buildSessionSidebarRowModel(input));
    expect(rows.filter((row) => row.startsWith('mixed-compact')).slice(-3)).toEqual(['mixed-compact:waiting', 'mixed-compact:running', 'mixed-compact:idle']);
  });

  test('a filtered search without a match shows the search empty state', () => {
    const input = args([project([group([node('running')])])]);
    input.mode = 'search';
    input.normalizedQuery = 'nothing';
    input.statusFilter = 'running';
    input.runningItems = [];

    expect(zoneRows(buildSessionSidebarRowModel(input))).toEqual(['empty:search']);
  });
});

describe('host lists', () => {
  const remoteRow = (id: string, extra: Partial<HostSessionSummary> = {}): HostSessionSummary => ({
    id, title: id, directory: '/work/app', updatedAt: 1, state: 'idle', work: null, ...extra,
  });
  const descriptor = (id: string): HostDescriptor => ({
    id, label: id, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true,
  });
  const monitored = (
    id: string,
    rows: HostSessionSummary[],
    connection: HostConnection = { state: 'live', since: 1, via: 'stream' },
    status: 'loading' | 'ready' | 'error' = 'ready',
  ) => projectMonitoredHost({
    descriptor: descriptor(id),
    connection,
    snapshot: { status, sessions: new Map(rows.map((entry) => [entry.id, entry])), lastCompleteAt: 1 },
  });
  const local = (id: string, updatedAt: number, flags: { waiting?: boolean; running?: boolean; pinned?: boolean; current?: boolean; children?: SessionNode[] } = {}): HostSessionEntry<SessionSidebarActivityItem> => ({
    id,
    value: timelineItem(id, {
      node: { session: session(id), children: flags.children ?? [], worktree: null },
      secondaryMeta: null,
    }),
    title: id,
    createdAt: updatedAt,
    updatedAt,
    waiting: flags.waiting ?? false,
    running: flags.running ?? false,
    pinned: flags.pinned ?? false,
    current: flags.current ?? false,
  });
  const hostsArgs = (
    remote: ReturnType<typeof monitored>[],
    activeSessions: HostSessionEntry<SessionSidebarActivityItem>[] = [local('a', 1)],
    collapsed: string[] = [],
  ): SessionSidebarHosts => ({
    active: { id: 'mac', label: 'Mac', kind: 'direct', displayUrl: 'http://127.0.0.1:3000', runtimeKey: 'host:mac', monitored: true },
    activeRuntimeKey: 'host:mac',
    activeSessions,
    activeNewSession: { projectId: 'project-a', directory: '/repo' },
    monitored: remote,
    pinned: null,
    collapsed: new Set(collapsed),
    order: [],
    sort: 'activity',
  });
  const hostRows = (model: ReturnType<typeof buildSessionSidebarRowModel>) => model.rows.flatMap((row) => {
    switch (row.kind) {
      case 'activity-header': return [`header:${row.activityKey}`];
      case 'host-header': return [`host:${row.runtimeKey}${row.collapsed ? ':collapsed' : ''}`];
      case 'host-status': return [`status:${row.host.descriptor.id}`];
      case 'project-header': return [`project:${row.section.project.id}`];
      case 'session': return [`${row.renderContext}:${'  '.repeat(row.depth)}${row.node.session.id}`];
      case 'remote-session': return [`${row.renderContext}:${'  '.repeat(row.depth)}${row.item.session.id}${row.dimmed ? ':dimmed' : ''}`];
      case 'show-control': return [`${row.control}:${row.containerKey}`];
      case 'empty': return [`empty:${row.emptyKind}`];
      default: return [];
    }
  });

  test('one host shows no host header', () => {
    const model = buildSessionSidebarRowModel(args([project([group([node('a')])])]));
    expect(model.rows.some((row) => row.kind === 'host-header')).toBe(false);
  });

  test('each host lists its sessions straight under its header, waiting ones included', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    input.attentionItems = [timelineItem('b')];
    input.zoneSessionIds = new Set(['a', 'b']);
    input.hosts = hostsArgs(
      [monitored('studio', [remoteRow('api', { directory: '/work/api', updatedAt: 3 }), remoteRow('app', { updatedAt: 1 })])],
      [local('a', 2), local('b', 1, { waiting: true })],
    );

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'host:host:mac', 'project:a', 'project:b',
      'host:host:studio', 'tree:api', 'tree:app',
    ]);
    expect(model.rows.find((row) => row.kind === 'host-header')).toMatchObject({ kind: 'host-header', newSession: { projectId: 'project-a', directory: '/repo' } });
    expect(model.rows.find((row) => row.key === 'host:host:studio:header')).toMatchObject({ newSession: { projectId: null, directory: '/work/api' } });
    expect(model.stickyHeaders.filter((header) => header.kind === 'host').map((header) => header.id)).toEqual(['host:mac', 'host:studio']);
  });

  test('sessions in work are listed once under their host, with no In work zone', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    input.workEntries = sessionWorks([timelineItem('a')]);
    const studio = monitored('studio', [remoteRow('api', { work: 'open', updatedAt: 3 }), remoteRow('app', { updatedAt: 1 })]);
    input.hosts = hostsArgs([studio], [local('a', 2), local('b', 1)]);

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'host:host:mac', 'project:a', 'project:b',
      'host:host:studio', 'tree:api', 'tree:app',
    ]);
    expect(model.stickyHeaders.map((header) => `${header.kind}:${header.id}`)).toEqual(['host:host:mac', 'host:host:studio']);
  });

  test('a pinned and in-work remote session and a pinned local session appear once, under their host lists, with no Pinned or Needs you zone', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    input.workEntries = sessionWorks([timelineItem('b')]);
    input.pinnedItems = [timelineItem('b')];
    const studio = monitored('studio', [
      remoteRow('lead', { work: 'open', pinned: true, updatedAt: 1 }),
      remoteRow('asks', { state: 'waiting-input', updatedAt: 5 }),
    ]);
    input.hosts = hostsArgs([studio], [local('a', 8), local('b', 2, { pinned: true })]);

    const model = buildSessionSidebarRowModel(input);
    const rows = hostRows(model);

    expect(rows.filter((row) => row.endsWith(':lead'))).toEqual(['tree:lead']);
    expect(rows.filter((row) => row.endsWith(':b'))).toEqual(['project:b']);
    expect(rows.filter((row) => row.endsWith(':asks'))).toEqual(['tree:asks']);
    expect(model.rows.some((row) => row.kind === 'activity-header' && (row.activityKey === 'pinned' || row.activityKey === 'attention'))).toBe(false);
  });

  test('the Pinned zone mixes every host in the given order, and its sessions leave their host lists', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    const studio = monitored('studio', [
      remoteRow('lead', { pinned: true, updatedAt: 1 }),
      remoteRow('other', { updatedAt: 5 }),
    ]);
    const localB = local('b', 2, { pinned: true });
    input.hosts = {
      ...hostsArgs([studio], [local('a', 8), localB]),
      pinned: [
        { kind: 'remote', sortKey: 'label:studio#lead', item: studio.sessions.find((item) => item.session.id === 'lead')! },
        { kind: 'local', sortKey: 'label:mac#b', item: localB.value },
      ],
    };

    const model = buildSessionSidebarRowModel(input);
    const rows = hostRows(model);

    expect(rows.slice(0, 3)).toEqual(['header:pinned', 'tree:lead', 'project:b']);
    expect(rows.filter((row) => row.endsWith(':lead') || row.endsWith(':b'))).toEqual(['tree:lead', 'project:b']);
    expect(rows).toContain('tree:other');
    expect(model.rows.filter((row) => row.pinnedSortKey !== undefined).map((row) => row.pinnedSortKey)).toEqual(['label:studio#lead', 'label:mac#b']);
  });

  test('with the Pinned zone hidden, pinned sessions stay in their host lists', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    const studio = monitored('studio', [remoteRow('lead', { pinned: true })]);
    input.hosts = hostsArgs([studio], [local('b', 2, { pinned: true })]);

    const rows = hostRows(buildSessionSidebarRowModel(input));

    expect(rows).not.toContain('header:pinned');
    expect(rows).toContain('tree:lead');
    expect(rows).toContain('project:b');
  });

  test('search lists a session in work once, under its host', () => {
    const input = args([]);
    input.mode = 'search';
    input.normalizedQuery = 'fix';
    input.workEntries = sessionWorks([timelineItem('fix-a')]);
    const studio = monitored('studio', [remoteRow('fix-r', { work: 'open', updatedAt: 2 }), remoteRow('fix-s', { updatedAt: 1 }), remoteRow('away', { work: 'open' })]);
    input.hosts = hostsArgs([studio], [local('fix-a', 2), local('fix-b', 1)]);

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'host:host:mac', 'project:fix-a', 'project:fix-b',
      'host:host:studio', 'tree:fix-r', 'tree:fix-s',
    ]);
    expect(model.searchMatchCount).toBe(4);
  });

  test('a host shows three sessions, waiting and pinned ones always, and the rest on Show more', () => {
    const input = args([]);
    const older = Array.from({ length: 12 }, (_, index) => local(`old-${index}`, 7 - index / 100));
    input.hosts = hostsArgs([], [
      local('recent', 9),
      local('pinned', 1, { pinned: true }),
      local('asks', 2, { waiting: true }),
      ...older,
    ]);

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:pinned', 'project:recent', 'project:asks', 'more:host-list:host:mac',
    ]);
    const more = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'show-control');
    expect(more).toMatchObject({ control: 'more', containerKey: 'host-list:host:mac' });

    input.visibleCountByContainer = revealAllSessions(input.visibleCountByContainer, 'host-list:host:mac');
    const page = hostRows(buildSessionSidebarRowModel(input));
    expect(page.filter((row) => row.startsWith('project:'))).toHaveLength(15);
    expect(page.at(-1)).toBe('fewer:host-list:host:mac');
  });

  test('a watched host lists the sessions pinned on it first, as its own clients do', () => {
    const input = args([]);
    input.hosts = hostsArgs([monitored('studio', [
      remoteRow('new', { updatedAt: 9 }),
      remoteRow('pinned-old', { updatedAt: 1, pinned: true }),
      remoteRow('mid', { updatedAt: 5 }),
    ])], []);

    const rows = hostRows(buildSessionSidebarRowModel(input)).filter((row) => row.startsWith('tree:'));

    expect(rows).toEqual(['tree:pinned-old', 'tree:new', 'tree:mid']);
  });

  test('a host keeps its open session listed past the first three', () => {
    const input = args([]);
    input.hosts = hostsArgs([], [
      local('a', 9),
      local('b', 8),
      local('c', 7),
      local('d', 6),
      local('open', 2, { current: true }),
    ]);

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:a', 'project:b', 'project:open', 'more:host-list:host:mac',
    ]);
  });

  test('a host with a hundred sessions, all in work, lists three and Show more, focused or not, and keeps hosts in their order', () => {
    const roots = Array.from({ length: 100 }, (_, index) => index);
    const msi = monitored('msi', roots.slice(0, 13).map((index) => remoteRow(`msi-${index}`, { work: 'open', updatedAt: 100 - index })));
    const pi5 = monitored('pi5', [remoteRow('pi-1', { work: 'open' })]);
    const input = args([]);
    input.hosts = {
      ...hostsArgs([msi, pi5], roots.map((index) => local(`mac-${index}`, 100 - index))),
      order: ['host:mac', 'host:msi', 'host:pi5'],
    };

    const rows = hostRows(buildSessionSidebarRowModel(input));
    const section = (host: string) => {
      const start = rows.indexOf(`host:host:${host}`);
      const next = rows.findIndex((row, index) => index > start && row.startsWith('host:host:'));
      return rows.slice(start + 1, next < 0 ? undefined : next);
    };
    expect(rows.filter((row) => row.startsWith('host:host:'))).toEqual(['host:host:mac', 'host:host:msi', 'host:host:pi5']);
    expect(section('mac')).toEqual(['project:mac-0', 'project:mac-1', 'project:mac-2', 'more:host-list:host:mac']);
    expect(section('msi')).toEqual(['tree:msi-0', 'tree:msi-1', 'tree:msi-2', 'more:host-list:host:msi']);
    expect(section('pi5')).toEqual(['tree:pi-1']);
  });

  test('sorted by status, a watched host ranks what waits on the user and what runs first; a failed turn does not hold a slot', () => {
    const input = args([]);
    input.hosts = { ...hostsArgs([monitored('studio', [
      remoteRow('new', { updatedAt: 9 }),
      remoteRow('failed', { state: 'failed', updatedAt: 8 }),
      remoteRow('busy', { state: 'running', updatedAt: 2 }),
      remoteRow('asks', { state: 'waiting-input', updatedAt: 1 }),
    ])]), sort: 'status' };

    expect(hostRows(buildSessionSidebarRowModel(input)).slice(2)).toEqual([
      'host:host:studio', 'tree:asks', 'tree:busy', 'tree:new', 'more:host-list:host:studio',
    ]);
  });

  test('hosts follow the saved order, wherever the focus is', () => {
    const studio = monitored('studio', [remoteRow('api')]);
    const laptop = monitored('laptop', [remoteRow('cli')]);
    const input = args([]);
    input.hosts = { ...hostsArgs([studio, laptop], [local('a', 1)]), order: ['host:laptop', 'host:mac', 'host:studio'] };

    expect(hostRows(buildSessionSidebarRowModel(input)).filter((row) => row.startsWith('host:'))).toEqual([
      'host:host:laptop', 'host:host:mac', 'host:host:studio',
    ]);
  });

  test('subsessions nest under their parent, collapsed until the parent is opened', () => {
    const input = args([]);
    input.hosts = hostsArgs(
      [monitored('studio', [remoteRow('lead', { updatedAt: 3 }), remoteRow('helper-1', { parentID: 'lead', updatedAt: 4 }), remoteRow('helper-2', { parentID: 'lead', updatedAt: 5 })])],
      [local('main', 1, { children: [node('argon-1'), node('argon-2')] })],
    );

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual(['host:host:mac', 'project:main', 'host:host:studio', 'tree:lead']);
    const leadRow = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'remote-session');
    expect(leadRow).toMatchObject({ expansionKey: 'remote:host:studio:lead', expanded: false });

    input.expandedParents = new Set(['project:active:main', 'remote:host:studio:lead']);
    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:main', 'project:  argon-1', 'project:  argon-2',
      'host:host:studio', 'tree:lead', 'tree:  helper-2', 'tree:  helper-1',
    ]);
  });

  test('a collapsed host keeps only its header', () => {
    const input = args([]);
    input.hosts = hostsArgs([monitored('studio', [remoteRow('x')])], [local('a', 1)], ['host:mac', 'host:studio']);

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual(['host:host:mac:collapsed', 'host:host:studio:collapsed']);
  });

  test('this host without sessions shows its empty state under its header', () => {
    const input = args([]);
    input.hosts = hostsArgs([monitored('studio', [remoteRow('x')])], []);
    expect(hostRows(buildSessionSidebarRowModel(input)).slice(0, 3)).toEqual(['host:host:mac', 'empty:sidebar', 'host:host:studio']);
  });

  test('a host whose list is not current keeps it dimmed under the line saying why', () => {
    const input = args([]);
    input.hosts = hostsArgs([
      monitored('down', [remoteRow('kept')], { state: 'backoff', failure: 'unreachable', retryAt: 9 }, 'error'),
      monitored('empty', []),
    ]);

    expect(hostRows(buildSessionSidebarRowModel(input)).slice(2)).toEqual([
      'host:host:down', 'status:down', 'tree:kept:dimmed',
      'host:host:empty', 'status:empty',
    ]);
  });

  test('the status filters list watched hosts\' sessions too', () => {
    const input = args([project([group([])])]);
    input.hosts = hostsArgs([monitored('studio', [
      remoteRow('asks', { state: 'waiting-permission' }),
      remoteRow('busy', { state: 'running' }),
    ])]);
    input.statusFilter = 'running';
    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual(['header:running', 'timeline-mixed:busy']);
    input.statusFilter = 'attention';
    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual(['header:attention', 'timeline-mixed:asks']);
  });

  test('search lists every match under its host, a subsession inside its open parent, and leaves out hosts without one', () => {
    const input = args([]);
    input.mode = 'search';
    input.normalizedQuery = 'fix';
    input.hosts = hostsArgs([
      monitored('studio', [
        remoteRow('fix-1'), remoteRow('fix-2'), remoteRow('fix-3'), remoteRow('fix-4'),
        remoteRow('lead'), remoteRow('fix-child', { parentID: 'lead' }),
        remoteRow('other'),
      ]),
      monitored('laptop', [remoteRow('nothing')]),
    ], []);

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'host:host:studio', 'tree:fix-1', 'tree:fix-2', 'tree:fix-3', 'tree:fix-4', 'tree:lead', 'tree:  fix-child',
    ]);
    expect(model.searchMatchCount).toBe(5);
  });

  test('scheduled runs of this host and watched hosts leave the host lists for the section at the bottom', () => {
    const input = args([project([group([node('a'), node('run')])])]);
    input.scheduledItems = [timelineItem('run')];
    const studio = monitored('studio', [
      remoteRow('api', { updatedAt: 3 }),
      remoteRow('nightly', { updatedAt: 5, scheduled: true }),
      remoteRow('kept', { updatedAt: 4, scheduled: true, pinned: true }),
    ]);
    input.hosts = hostsArgs([studio], [local('a', 2), local('run', 1)]);

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:a',
      'host:host:studio', 'tree:kept', 'tree:api',
      'header:scheduled', 'timeline-mixed:nightly', 'mixed-compact:run',
    ]);
  });

  test('with grouping off, remote scheduled runs stay in their host list and there is no section', () => {
    const input = args([project([group([node('a')])])]);
    input.groupScheduled = false;
    const studio = monitored('studio', [
      remoteRow('api', { updatedAt: 3 }),
      remoteRow('nightly', { updatedAt: 5, scheduled: true }),
    ]);
    input.hosts = hostsArgs([studio], [local('a', 2)]);

    const rows = hostRows(buildSessionSidebarRowModel(input));
    expect(rows).toEqual(['host:host:mac', 'project:a', 'host:host:studio', 'tree:nightly', 'tree:api']);
  });

  test('a scheduled run that waits on the user is listed in the Scheduled section only', () => {
    const input = args([]);
    const studio = monitored('studio', [remoteRow('nightly', { scheduled: true, state: 'waiting-input' })]);
    input.hosts = hostsArgs([studio], []);

    const rows = hostRows(buildSessionSidebarRowModel(input));

    expect(rows).not.toContain('header:attention');
    expect(rows.slice(-2)).toEqual(['header:scheduled', 'timeline-mixed:nightly']);
  });
});

describe('Scheduled tasks section', () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `run${index + 1}`);
  const rowsOf = (model: ReturnType<typeof buildSessionSidebarRowModel>) => model.rows.flatMap((row) => {
    if (row.kind === 'activity-header') return [`header:${row.activityKey}${row.collapsed ? ':collapsed' : ''}`];
    if (row.kind === 'project-header') return [`project:${row.section.project.id}`];
    if (row.kind === 'session') return [`${row.renderContext}:${row.node.session.id}`];
    if (row.kind === 'show-control') return [`${row.control}:${row.containerKey}`];
    return [];
  });

  test('scheduled runs leave their project and close the list in their own section', () => {
    const input = args([project([group([node('run1'), node('other')])])]);
    input.chatGroup = group([node('chat'), node('run2')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.scheduledItems = [timelineItem('run1'), timelineItem('run2')];

    const model = buildSessionSidebarRowModel(input);

    expect(rowsOf(model)).toEqual([
      'header:chats', 'tree-chat:chat',
      'project:project-a', 'project:other',
      'header:scheduled', 'mixed-compact:run1', 'mixed-compact:run2',
    ]);
    expect(model.rows.find((row) => row.kind === 'activity-header' && row.activityKey === 'scheduled')).toMatchObject({ count: 2 });
    expect(model.stickyHeaders.at(-1)).toMatchObject({ kind: 'activity', id: 'scheduled' });
  });

  test('no section without scheduled runs', () => {
    const rows = rowsOf(buildSessionSidebarRowModel(args([project([group([node('other')])])])));
    expect(rows.some((row) => row.startsWith('header:scheduled'))).toBe(false);
  });

  test('timeline leaves scheduled runs out of their project', () => {
    const input = args([project([group([node('run1'), node('other')])])]);
    input.timeEntries = sessionWorks([timelineItem('run1'), timelineItem('other')]);
    input.scheduledItems = [timelineItem('run1')];

    expect(rowsOf(buildSessionSidebarRowModel(input))).toEqual([
      'header:timeline', 'mixed-compact:other',
      'header:scheduled', 'mixed-compact:run1',
    ]);
  });

  test('shows three at first, the rest on Show more, then Show fewer', () => {
    const runs = ids(5);
    const input = args([project([group(runs.map((id) => node(id)))])]);
    input.scheduledItems = runs.map((id) => timelineItem(id));

    const first = rowsOf(buildSessionSidebarRowModel(input));
    expect(first.filter((row) => row.startsWith('mixed-compact:'))).toEqual(['mixed-compact:run1', 'mixed-compact:run2', 'mixed-compact:run3']);
    expect(first.at(-1)).toBe('more:activity:scheduled');

    input.visibleCountByContainer = revealAllSessions(input.visibleCountByContainer, 'activity:scheduled');
    const expanded = rowsOf(buildSessionSidebarRowModel(input));
    expect(expanded.filter((row) => row.startsWith('mixed-compact:'))).toHaveLength(5);
    expect(expanded.at(-1)).toBe('fewer:activity:scheduled');
  });

  test('the open run stays listed past the first three and under a collapsed header', () => {
    const runs = ids(5);
    const input = args([project([group(runs.map((id) => node(id)))])]);
    input.scheduledItems = runs.map((id) => timelineItem(id));
    input.currentSessionId = 'run5';

    expect(rowsOf(buildSessionSidebarRowModel(input)).filter((row) => row.startsWith('mixed-compact:')))
      .toEqual(['mixed-compact:run1', 'mixed-compact:run2', 'mixed-compact:run3', 'mixed-compact:run5']);

    input.collapsedActivities = new Set(['scheduled']);
    expect(rowsOf(buildSessionSidebarRowModel(input))).toEqual(['project:project-a', 'header:scheduled:collapsed', 'mixed-compact:run5']);
    expect(SIDEBAR_ACTIVITY_KEYS).toContain('scheduled');
  });

  test('a scheduled run that waits on the user stays in Needs you and in the filter', () => {
    const input = args([project([group([node('run1')])])]);
    input.attentionItems = [timelineItem('run1')];
    input.scheduledItems = [timelineItem('run1')];

    expect(rowsOf(buildSessionSidebarRowModel(input))).toEqual([
      'header:attention', 'mixed-compact:run1',
      'project:project-a',
      'header:scheduled', 'mixed-compact:run1',
    ]);

    input.statusFilter = 'attention';
    expect(rowsOf(buildSessionSidebarRowModel(input))).toEqual(['header:attention', 'mixed-compact:run1']);
  });
});

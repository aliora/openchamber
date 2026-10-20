import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, countSessionSearchMatches, resolveSessionSidebarStickyHeader, runExpansionKey, SIDEBAR_ACTIVITY_KEYS, timelineProjectContainerKey, type SessionSidebarActivityItem, type SessionSidebarHosts, type SessionSidebarRowModelArgs } from './sessionSidebarRowModel';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { HostConnection, HostDescriptor, HostSessionSummary } from '@/lib/hosts/types';
import { projectMonitoredHost, selectRemoteWork, type RemoteSessionItem } from './hosts/remoteHostProjection';
import type { HostSessionEntry } from './hosts/hostSessionList';

const timelineItem = (id: string, overrides: Partial<SessionSidebarActivityItem> = {}): SessionSidebarActivityItem => ({
  node: { session: session(id), children: [], worktree: null },
  projectId: 'project-a',
  groupDirectory: '/repo',
  secondaryMeta: { projectLabel: 'repo', branchLabel: 'main' },
  ...overrides,
});

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
    input.workItems = [timelineItem('working')];
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
    input.workItems = [timelineItem('working')];
    input.zoneSessionIds = new Set(['working']);
    input.detailedZoneRows = true;

    const rows = buildSessionSidebarRowModel(input).rows;
    const zoneRow = rows.find((row) => row.kind === 'session');

    expect(zoneRow?.kind === 'session' && zoneRow.renderContext).toBe('timeline-mixed');
  });

  test('Pinned opens above In work and its sessions stay in their project', () => {
    const input = args([project([group([node('pinned'), node('working')])])]);
    input.pinnedItems = [timelineItem('pinned')];
    input.workItems = [timelineItem('working')];
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
    input.workItems = [timelineItem('in-folder')];
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
    input.workItems = [{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }];
    input.zoneSessionIds = new Set(['ses_parent']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));

    expect(model.searchMatchCount).toBe(1);
    expect(rows).toEqual(['ses_parent']);
    expect(model.selectionEntries.filter((entry) => entry.id === 'ses_parent')).toHaveLength(1);
  });

  test('timeline leaves sessions listed in Pinned out of their project', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('pinned'), timelineItem('working'), timelineItem('other')];
    input.pinnedItems = [timelineItem('pinned')];
    input.workItems = [timelineItem('working')];
    input.zoneSessionIds = new Set(['pinned', 'working']);

    const sessions = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`] : []
    ));

    expect(sessions).toEqual(['timeline-mixed:pinned', 'timeline-mixed:working', 'timeline:working', 'timeline:other']);
  });

  test('timeline lists work sessions with the project icon and keeps them in their project', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('working'), timelineItem('other')];
    input.workItems = [timelineItem('working')];
    input.zoneSessionIds = new Set(['working']);

    const rows = buildSessionSidebarRowModel(input).rows;
    const headers = rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? [row.section.project.id] : []));
    const sessions = rows.flatMap((row) => (row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`] : []));

    expect(headers).toEqual(['work', 'project-a']);
    expect(sessions).toEqual(['timeline-mixed:working', 'timeline:working', 'timeline:other']);
  });

  test('timeline reveals seven sessions per project, seven more per Show more', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.timelineItems = Array.from({ length: 16 }, (_, index) => timelineItem(`s${index}`));

    for (const count of [7, 14, 16]) {
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(count);
      const control = model.rows.find((row) => row.kind === 'show-control');
      if (!control || control.kind !== 'show-control') throw new Error('Missing reveal control');
      expect(control.containerKey).toBe(timelineProjectContainerKey('project-a'));
      expect(control.control).toBe(count === 16 ? 'fewer' : 'more');
      input.visibleCountByContainer = new Map([[control.containerKey, control.currentCount + control.increment]]);
    }
  });

  test('timeline shows a space without chats as its group header until its first chat', () => {
    const space = { id: 'space1', name: 'fresh', state: 'complete' as const, projectDirectory: '/repo', directory: '/spaces/space1/repo' };
    const empty = group([], { id: 'space-empty', label: 'fresh', isMain: false, directory: '/spaces/space1/repo', space });
    const used = group([node('in-space')], { id: 'space-used', label: 'used', isMain: false, directory: '/spaces/space2/repo', space: { ...space, id: 'space2', name: 'used' } });
    const input = args([project([group([]), empty, used])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('in-space')];

    const rows = buildSessionSidebarRowModel(input).rows;
    expect(rows.map((row) => row.kind === 'group-header' ? `group:${row.group.id}:${row.empty}` : row.kind === 'session' ? `session:${row.node.session.id}` : row.kind))
      .toEqual(['project-header', 'group:space-empty:true', 'session:in-space']);

    input.mode = 'search';
    input.normalizedQuery = 'in-space';
    expect(buildSessionSidebarRowModel(input).rows.some((row) => row.kind === 'group-header')).toBe(false);
  });

  test('timeline waits for a space\'s chats to load and shows a failed load as in the Tree', () => {
    const space = { id: 'space1', name: 'fresh', state: 'complete' as const, projectDirectory: '/repo', directory: '/spaces/space1/repo' };
    const empty = group([], { id: 'space-empty', label: 'fresh', isMain: false, directory: '/spaces/space1/repo', space });
    const input = args([project([group([]), empty])]);
    input.viewMode = 'timeline';
    const statusOf = (state: 'loading' | 'load-failed') => new Map([['project-a:space-empty', { state, directory: '/spaces/space1/repo', canGrantAccess: false }]]);

    input.groupStatusByKey = statusOf('loading');
    expect(buildSessionSidebarRowModel(input).rows.map((row) => row.kind)).toEqual(['project-header']);

    input.groupStatusByKey = statusOf('load-failed');
    expect(buildSessionSidebarRowModel(input).rows.map((row) => row.kind === 'group-header' ? `group-header:${row.empty}` : row.kind))
      .toEqual(['project-header', 'group-header:false', 'status']);
  });

  test('a collapsed timeline project shows only its header', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('a')];
    input.collapsedProjects = new Set(['project-a']);

    expect(buildSessionSidebarRowModel(input).rows).toMatchObject([{ kind: 'project-header', collapsed: true }]);
  });

  test('keeps badge scopes for hidden timeline descendants without adding child rows', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('root', {
      blockingBadgeSessionScopes: [
        { directory: '/repo', sessionIDs: ['root'] },
        { directory: '/worktree', sessionIDs: ['child'] },
      ],
    })];
    input.workItems = [timelineItem('working', {
      blockingBadgeSessionScopes: [
        { directory: '/repo', sessionIDs: ['working'] },
        { directory: '/worktree', sessionIDs: ['worker'] },
      ],
    })];
    input.zoneSessionIds = new Set(['working']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.filter((row) => row.kind === 'session');
    expect(rows.map((row) => row.node.session.id)).toEqual(['working', 'root']);
    expect(rows.map((row) => row.blockingBadgeSessionScopes?.[1]?.sessionIDs)).toEqual([['worker'], ['child']]);
    expect(rows.every((row) => row.node.children.length === 0)).toBe(true);
    expect(model.selectionEntries.map((entry) => entry.id)).toEqual(['working', 'root']);
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
    input.workItems = [{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }];
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
    input.workItems = [{ ...timelineItem('ses_parent'), node: { ...parent, children: [] }, searchMatchCount: countSessionTreeQueryMatches(parent, 'header') }];
    input.zoneSessionIds = new Set(['ses_parent']);

    expect(buildSessionSidebarRowModel(input).searchMatchCount).toBe(2);
  });

  test('in work sits under Chats and above the projects', () => {
    const working = node('working');
    const input = args([project([group([working, node('other')])])]);
    input.chatGroup = group([node('chat')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.workItems = [timelineItem('working')];
    input.zoneSessionIds = new Set(['working']);

    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? [row.section.project.id] : []
    ));

    expect(headers).toEqual(['chats', 'work', 'project-a']);
  });

  test('no block while nothing is in work', () => {
    const input = args([project([group([node('other')])])]);
    input.workItems = [];
    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : []));
    expect(headers).not.toContain('work');
  });

  test('uses occurrence keys while retaining duplicate session IDs in logical order', () => {
    const repeated = node('same-session');
    const input = args([project([group([repeated])])]);
    input.workItems = [{ node: repeated, projectId: 'project-a', groupDirectory: '/repo', secondaryMeta: null }];
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

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(7);
    expect(model.rows.some((row) => row.kind === 'show-control' && row.control === 'more')).toBe(true);
  });

  test('single-project flat mode reveals twenty at a time and resets without changing Chats', () => {
    const nodes = Array.from({ length: 45 }, (_, index) => node(`session-${index}`));
    const input = args([project([group(nodes)])]);
    input.singleProjectMode = true;
    input.singleProjectId = 'project-a';
    input.sessionBatchSize = 20;
    input.chatGroup = group(nodes, { id: 'managed-chats' });
    for (const count of [20, 40, 45]) {
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.filter((row) => row.kind === 'session' && row.projectId === 'project-a')).toHaveLength(count);
      expect(model.rows.filter((row) => row.kind === 'session' && row.projectId === null)).toHaveLength(3);
      const control = model.rows.find((row) => row.kind === 'show-control' && row.containerKey === 'project-a:main');
      if (!control || control.kind !== 'show-control') throw new Error('Missing reveal control');
      expect(control.increment).toBe(20);
      expect(control.control).toBe(count === 45 ? 'fewer' : 'more');
      if (control.control === 'more') input.visibleCountByContainer = new Map([[control.containerKey, control.currentCount + control.increment]]);
      else input.visibleCountByContainer = new Map();
    }
    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session' && row.projectId === 'project-a')).toHaveLength(20);
  });

  test('Chats keep the tree slot in Tree and stay flat in List', () => {
    const input = args([]);
    input.chatGroup = group(Array.from({ length: 5 }, (_, index) => node(`chat-${index}`)), { id: 'managed-chats' });
    const chatRows = (viewMode: SessionSidebarRowModelArgs['viewMode']) => {
      const rows = buildSessionSidebarRowModel({ ...input, viewMode }).rows;
      return {
        contexts: [...new Set(rows.flatMap((row) => (row.kind === 'session' ? [row.renderContext] : [])))],
        control: rows.find((row) => row.kind === 'show-control'),
      };
    };

    expect(chatRows('projects')).toMatchObject({ contexts: ['tree-chat'], control: { flat: false } });
    expect(chatRows('timeline')).toMatchObject({ contexts: ['timeline-chat'], control: { flat: true } });
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

  test('timeline mode lists root sessions flat under their project header, without worktree groups', () => {
    const worktree = group([node('worktree-session')], { id: 'worktree:/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt' });
    const input = args([project([group([node('project-session', [node('child')])]), worktree])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('a'), timelineItem('b')];

    const model = buildSessionSidebarRowModel(input);
    const sessions = model.rows.filter((row) => row.kind === 'session');

    expect(model.rows[0]).toMatchObject({ kind: 'project-header' });
    expect(model.rows.some((row) => row.kind === 'group-header' || row.kind === 'activity-header')).toBe(false);
    expect(model.stickyHeaders.map((header) => header.id)).toEqual(['project-a']);
    expect(sessions.map((row) => row.node.session.id)).toEqual(['a', 'b']);
    expect(sessions.every((row) => row.renderContext === 'timeline' && row.depth === 0)).toBe(true);
    expect(model.rows.some((row) => row.kind === 'show-control')).toBe(false);
  });

  for (const viewMode of ['projects', 'timeline'] as const) {
    test(`${viewMode} mode reveals three chats and never counts pinned chats against that limit`, () => {
      const chats = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 6 }, (_, index) => node(`chat-${index}`))];
      const input = args([]);
      input.viewMode = viewMode;
      input.chatGroup = group(chats, { id: 'managed-chats' });
      input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

      const model = buildSessionSidebarRowModel(input);
      const shown = model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id);

      expect(shown).toContain('pinned-1');
      expect(shown).toContain('pinned-2');
      expect(shown.filter((id) => id.startsWith('chat-'))).toHaveLength(3);
      const control = model.rows.find((row) => row.kind === 'show-control');
      expect(control).toMatchObject({ control: 'more', currentCount: 3, increment: 7 });
    });
  }

  test('pinned project sessions spend the reveal limit', () => {
    const nodes = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 8 }, (_, index) => node(`s${index}`))];
    const input = args([project([group(nodes)])]);
    input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session')).toHaveLength(7);
  });

  test('timeline search counts one match per listed session', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';
    input.mode = 'search';
    input.normalizedQuery = 'a';
    input.timelineItems = [timelineItem('a'), timelineItem('b')];

    expect(buildSessionSidebarRowModel(input).searchMatchCount).toBe(2);
  });

  test('a timeline project without sessions shows only its header', () => {
    const input = args([project([group([])])]);
    input.viewMode = 'timeline';

    expect(buildSessionSidebarRowModel(input).rows).toMatchObject([{ kind: 'project-header' }]);
    expect(buildSessionSidebarRowModel(input).rows).toHaveLength(1);
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

  test('timeline mode shows the sidebar empty row without projects', () => {
    const input = args([]);
    input.viewMode = 'timeline';

    expect(buildSessionSidebarRowModel(input).rows).toMatchObject([{ kind: 'empty', emptyKind: 'sidebar' }]);
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
      expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(6);
    });

    test('an In work run row never expands and carries the sessions that block its lanes', () => {
      const input = args([]);
      input.runIndex = runIndex;
      input.workItems = [
        timelineItem('lane-1', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-1', 'lane-1-child'] }] }),
        timelineItem('lane-2', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-2'] }] }),
      ];
      input.zoneSessionIds = new Set(['lane-1', 'lane-2']);
      input.expandedParents = new Set([runExpansionKey('mixed-compact', runKey)]);
      const rows = buildSessionSidebarRowModel(input).rows;
      const run = rows.find((row) => row.kind === 'run');

      expect(rows.some((row) => row.kind === 'session')).toBe(false);
      expect(run?.kind === 'run' && [...run.blockingSessionIds]).toEqual(['lane-1', 'lane-1-child', 'lane-2']);
    });

    test('a timeline run row carries the sessions that block its lanes', () => {
      const input = args([project([group([])])]);
      input.viewMode = 'timeline';
      input.runIndex = runIndex;
      input.timelineItems = [
        timelineItem('lane-1', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-1', 'lane-1-subagent'] }] }),
        timelineItem('lane-2', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-2'] }] }),
      ];
      const run = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'run');

      expect(run?.kind === 'run' && [...run.blockingSessionIds]).toEqual(['lane-1', 'lane-1-subagent', 'lane-2']);
    });

    test('timeline items collapse into one run row', () => {
      const input = args([project([group([])])]);
      input.viewMode = 'timeline';
      input.runIndex = runIndex;
      input.timelineItems = [timelineItem('lane-1'), timelineItem('a'), timelineItem('lane-2')];
      const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run' || row.kind === 'session');

      expect(rows.map((row) => (row.kind === 'session' ? row.node.session.id : row.kind))).toEqual(['run', 'a']);
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

  test('uses the two-line rows in List', () => {
    const input = args([project([group([node('waiting')])])]);
    input.viewMode = 'timeline';
    input.attentionItems = [timelineItem('waiting')];
    input.zoneSessionIds = new Set(['waiting']);

    expect(zoneRows(buildSessionSidebarRowModel(input))[1]).toBe('timeline-mixed:waiting');
  });

  test('shows five at first, five more per Show more, then Show fewer', () => {
    const waiting = ids(7);
    const input = args([project([group([])])]);
    input.attentionItems = waiting.map((id) => timelineItem(id));

    const first = zoneRows(buildSessionSidebarRowModel(input));
    expect(first.filter((row) => row.startsWith('mixed-compact:'))).toEqual(waiting.slice(0, 5).map((id) => `mixed-compact:${id}`));
    expect(first).toContain('more:activity:attention');

    input.visibleCountByContainer = new Map([['activity:attention', 10]]);
    const expanded = zoneRows(buildSessionSidebarRowModel(input));
    expect(expanded.filter((row) => row.startsWith('mixed-compact:'))).toHaveLength(7);
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
    input.workItems = [timelineItem('working')];
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
  const local = (id: string, updatedAt: number, flags: { waiting?: boolean; running?: boolean; pinned?: boolean; children?: SessionNode[]; chip?: string } = {}): HostSessionEntry<SessionSidebarActivityItem> => ({
    id,
    value: timelineItem(id, {
      node: { session: session(id), children: flags.children ?? [], worktree: null },
      secondaryMeta: flags.chip ? { projectChip: flags.chip } : null,
    }),
    updatedAt,
    waiting: flags.waiting ?? false,
    running: flags.running ?? false,
    pinned: flags.pinned ?? false,
  });
  const hostsArgs = (
    remote: ReturnType<typeof monitored>[],
    activeSessions: HostSessionEntry<SessionSidebarActivityItem>[] = [local('a', 1)],
    collapsed: string[] = [],
    work: RemoteSessionItem[] = [],
  ): SessionSidebarHosts => ({
    active: { id: 'mac', label: 'Mac', kind: 'direct', displayUrl: 'http://127.0.0.1:3000', runtimeKey: 'host:mac', monitored: true },
    activeRuntimeKey: 'host:mac',
    activeSessions,
    activeNewSession: { projectId: 'project-a', directory: '/repo' },
    monitored: remote,
    collapsed: new Set(collapsed),
    work,
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

  test('each host lists its sessions straight under its header, with no project or zone rows', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    input.attentionItems = [timelineItem('b')];
    input.zoneSessionIds = new Set(['a', 'b']);
    input.hosts = hostsArgs(
      [monitored('studio', [remoteRow('api', { directory: '/work/api', updatedAt: 3 }), remoteRow('app', { updatedAt: 1 })])],
      [local('a', 2), local('b', 1, { waiting: true })],
    );

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'host:host:mac', 'project:b', 'project:a',
      'host:host:studio', 'tree:api', 'tree:app',
    ]);
    expect(model.rows[0]).toMatchObject({ kind: 'host-header', newSession: { projectId: 'project-a', directory: '/repo' } });
    expect(model.rows.find((row) => row.key === 'host:host:studio:header')).toMatchObject({ newSession: { projectId: null, directory: '/work/api' } });
    expect(model.stickyHeaders.filter((header) => header.kind === 'host').map((header) => header.id)).toEqual(['host:mac', 'host:studio']);
  });

  test('In work lists this host\'s and every watched host\'s sessions in work above the hosts, which keep them too', () => {
    const input = args([project([group([node('a'), node('b')])])]);
    input.workItems = [timelineItem('a')];
    const studio = monitored('studio', [remoteRow('api', { work: 'open', updatedAt: 3 }), remoteRow('app', { updatedAt: 1 })]);
    input.hosts = hostsArgs([studio], [local('a', 2), local('b', 1)], [], selectRemoteWork([studio]));

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'header:work', 'mixed-compact:a', 'timeline-mixed:api',
      'host:host:mac', 'project:a', 'project:b',
      'host:host:studio', 'tree:api', 'tree:app',
    ]);
    expect(model.stickyHeaders.map((header) => `${header.kind}:${header.id}`)).toEqual(['activity:work', 'host:host:mac', 'host:host:studio']);
  });

  test('two background hosts each list their own rows, and In work holds both, each row naming the host a click focuses', () => {
    const input = args([project([group([node('a')])])]);
    const studio = monitored('studio', [remoteRow('api', { work: 'open', updatedAt: 4 }), remoteRow('app', { updatedAt: 1 })]);
    const laptop = monitored('laptop', [remoteRow('cli', { work: 'open', updatedAt: 6 }), remoteRow('docs', { updatedAt: 2 })], { state: 'backoff', failure: 'unreachable', retryAt: 9 });
    input.hosts = hostsArgs([studio, laptop], [local('a', 1)], [], selectRemoteWork([studio, laptop]));

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'header:work', 'timeline-mixed:cli', 'timeline-mixed:api',
      'host:host:mac', 'project:a',
      'host:host:studio', 'tree:api', 'tree:app',
      'host:host:laptop', 'status:laptop', 'tree:cli:dimmed', 'tree:docs:dimmed',
    ]);
    const remoteTargets = model.rows.flatMap((row) => (row.kind === 'remote-session' ? [`${row.item.host.runtimeKey}:${row.item.session.id}`] : []));
    expect(remoteTargets).toEqual([
      'host:laptop:cli', 'host:studio:api',
      'host:studio:api', 'host:studio:app',
      'host:laptop:cli', 'host:laptop:docs',
    ]);
  });

  test('In work holds only watched hosts\' sessions when this host has none, and collapses to its header', () => {
    const input = args([]);
    const studio = monitored('studio', [remoteRow('api', { work: 'open' })]);
    input.hosts = hostsArgs([studio], [local('a', 1)], [], selectRemoteWork([studio]));
    expect(hostRows(buildSessionSidebarRowModel(input)).slice(0, 3)).toEqual(['header:work', 'timeline-mixed:api', 'host:host:mac']);

    input.collapsedActivities = new Set(['work']);
    expect(hostRows(buildSessionSidebarRowModel(input)).slice(0, 2)).toEqual(['header:work', 'host:host:mac']);
  });

  test('search lists a session in work once, in In work', () => {
    const input = args([]);
    input.mode = 'search';
    input.normalizedQuery = 'fix';
    input.workItems = [timelineItem('fix-a')];
    const studio = monitored('studio', [remoteRow('fix-r', { work: 'open', updatedAt: 2 }), remoteRow('fix-s', { updatedAt: 1 }), remoteRow('away', { work: 'open' })]);
    input.hosts = hostsArgs([studio], [local('fix-a', 2), local('fix-b', 1)], [], selectRemoteWork([studio]));

    const model = buildSessionSidebarRowModel(input);

    expect(hostRows(model)).toEqual([
      'header:work', 'mixed-compact:fix-a', 'timeline-mixed:fix-r',
      'host:host:mac', 'project:fix-b',
      'host:host:studio', 'tree:fix-s',
    ]);
    expect(model.searchMatchCount).toBe(4);
  });

  test('a host shows three sessions, waiting and pinned ones always, and the rest behind Show more', () => {
    const input = args([]);
    input.hosts = hostsArgs([], [
      local('recent', 9),
      local('older', 8),
      local('oldest', 7),
      local('pinned', 1, { pinned: true }),
      local('asks', 2, { waiting: true }),
    ]);

    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:asks', 'project:pinned', 'project:recent', 'more:host-list:host:mac',
    ]);

    input.visibleCountByContainer = new Map([['host-list:host:mac', 3]]);
    expect(hostRows(buildSessionSidebarRowModel(input))).toEqual([
      'host:host:mac', 'project:asks', 'project:pinned', 'project:recent', 'project:older', 'project:oldest', 'fewer:host-list:host:mac',
    ]);
  });

  test('a watched host ranks what waits on the user and what runs first; a failed turn does not hold a slot', () => {
    const input = args([]);
    input.hosts = hostsArgs([monitored('studio', [
      remoteRow('new', { updatedAt: 9 }),
      remoteRow('failed', { state: 'failed', updatedAt: 8 }),
      remoteRow('busy', { state: 'running', updatedAt: 2 }),
      remoteRow('asks', { state: 'waiting-input', updatedAt: 1 }),
    ])]);

    expect(hostRows(buildSessionSidebarRowModel(input)).slice(2)).toEqual([
      'host:host:studio', 'tree:asks', 'tree:busy', 'tree:new', 'more:host-list:host:studio',
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

  test('a row outside the host\'s main project carries its chip', () => {
    const input = args([]);
    input.hosts = hostsArgs([], [local('here', 2), local('elsewhere', 1, { chip: 'api' })]);
    const rows = buildSessionSidebarRowModel(input).rows.flatMap((row) => row.kind === 'session' ? [[row.node.session.id, row.secondaryMeta?.projectChip ?? null]] : []);
    expect(rows).toEqual([['here', null], ['elsewhere', 'api']]);
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
});

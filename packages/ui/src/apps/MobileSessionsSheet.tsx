import React from 'react';
import { createPortal } from 'react-dom';
import { isIMECompositionEvent } from '@/lib/ime';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { Icon } from '@/components/icon/Icon';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { SidebarFooter } from '@/components/session/sidebar/shell/SidebarFooter';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import type { SessionProjectListProps } from '@/components/session/sidebar/projects/SessionProjectScroller';
import { sortProjectsByOrder } from '@/components/session/sidebar/list/projectSort';
import { Button } from '@/components/ui/button';
import {
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';

import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { MobileProjectEditSurface } from './MobileProjectEditSurface';
import { MobileProjectIcon } from './MobileProjectIcon';
import { getSessionDirectory } from './mobileSessionFields';
import { getProjectLabel, normalizePath } from './mobilePaths';
import { MobileSessionList } from './mobileSidebar/MobileSessionList';
import { MobileSidebarActionsProvider, useMobileSidebarRowsStore, type MobileSidebarActions } from './mobileSidebar/mobileSidebarState';
import { useEdgeSwipe, type DrawerDragControl } from './useEdgeSwipe';
import { prefersReducedMotion } from '@/lib/layoutAnimation';
import { MobileHostReorderList } from './MobileHostSections';
import { HostMark } from '@/components/ui/HostMark';
import { useHostLabelFormatter } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useMobileHostOrder } from './useMobileHostOrder';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' (default) renders a full-width left drawer over the app;
      'sidebar' renders the same content inline for the iPad persistent
      sidebar, kept mounted while it is hidden, with `open` saying whether
      it is shown. */
  variant?: 'drawer' | 'sidebar';
  /** Lets the chat's opening edge swipe drag the drawer along with the finger. */
  openDragRef?: React.RefObject<DrawerDragControl | null>;
  /** App-level footer bar (desktop-sidebar-style): current instance on the
      left, settings (and, on hosted web, a pending update) on the right. */
  footer?: {
    /** Connected instance label — Capacitor only; null hides the left slot. */
    instanceLabel: string | null;
    onOpenInstances?: () => void;
    onOpenSettings: () => void;
    onOpenScheduled: () => void;
    onOpenArchive: () => void;
    onOpenUsage: () => void;
    /** The overview of what waits, runs and looks done; absent while the feature is not in this build. */
    onOpenOverview?: () => void;
  };
};

type ReorderProject = {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

const renderList = (props: SessionProjectListProps): React.ReactNode => <MobileSessionList {...props} />;

/** One draggable project in Reorder projects. */
const SortableProjectRow: React.FC<{ project: ReorderProject }> = ({ project }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn(
        'flex items-center gap-1 rounded-2xl border border-border/70 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <button
        type="button"
        className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.sessions.dragHandleAria', { label: project.label })}
        {...attributes}
        {...listeners}
      >
        <Icon name="drag-move-2" className="size-4" />
      </button>
      <MobileProjectIcon project={project} />
      <span className="block min-w-0 flex-1 truncate ps-1 typography-ui-label text-foreground">{project.label}</span>
    </div>
  );
};

/**
 * The phone's sessions drawer, and the iPad's sidebar. The list is the
 * desktop's (`SessionSidebar` with the phone's rows, see
 * `mobileSidebar/MobileSessionList.tsx`); this sheet holds what surrounds it:
 * the header with the display menu and New chat, the search field, Reorder
 * projects, the footer and the dialogs the rows open.
 */
export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({ open, onOpenChange, variant = 'drawer', footer, openDragRef }) => {
  const { t } = useI18n();
  const liveSessions = useAllLiveSessions();
  const projects = useProjectsStore((state) => state.projects);
  const manualProjectOrder = useProjectsStore((state) => state.manualProjectOrder);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const grouping = useSessionDisplayStore(resolveSidebarGrouping);
  // With other servers watched, each lists its sessions under its own header
  // (the sidebar's row model), in the order the user drags them.
  const hasWatchedHosts = useHostsStore((state) => state.hosts.length > 0);
  const activeHost = useHostsStore((state) => state.activeHost);
  const formatLabel = useHostLabelFormatter();
  const footerInstanceLabel = activeHost ? formatLabel(activeHost) : (footer?.instanceLabel ?? null);
  const hostOrder = useMobileHostOrder();
  const hasChats = useGlobalSessionsStore((state) => state.activeSessions.some((session) => isChatDirectoryPath(getSessionDirectory(session))));
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{ project: { id: string; path: string }; worktree: WorktreeMetadata } | null>(null);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [editingOrder, setEditingOrder] = React.useState(false);
  const [openId, setOpenId] = React.useState(0);
  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setEditingOrder(false);
      setEditingProjectId(null);
      useMobileSidebarRowsStore.getState().reset();
      return;
    }
    setOpenId((id) => id + 1);
    // The mobile shell has no global poller, so this load is also where the
    // host seed runs, as the poller runs it after each load elsewhere: a
    // question or permission already waiting at startup is otherwise missing
    // from the cross-directory index the rows read. The seed resolves
    // directories from the list just loaded, so it runs after it.
    void refreshGlobalSessions(liveSessions).then(() => seedGlobalSessionStatusFromHost());
    // intentionally only on open transition — session events keep the list current after that
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const sidebarActions = React.useMemo<MobileSidebarActions>(() => ({
    close,
    openProjectEdit: setEditingProjectId,
    // The dialog takes the project as a prop and the created worktree's draft
    // names it: the active project stays, so the chat behind the drawer does
    // not switch to that project's last session while the dialog is open.
    openNewWorktree: (projectId) => {
      setWorktreeDialogProjectId(projectId);
      setNewWorktreeDialogOpen(true);
    },
    requestWorktreeDelete: (project, worktree) => setWorktreeToDelete({ project, worktree }),
    openId,
  }), [close, openId]);
  const clearSearch = React.useCallback(() => setQuery(''), []);

  // Projects with the label the rows show, in the order Reorder projects drags.
  const labelledProjects = React.useMemo(() => projects.map((project) => ({
    ...project,
    label: project.label?.trim() || getProjectLabel(project.path),
  })), [projects]);
  const reorderList = React.useMemo(
    () => sortProjectsByOrder(labelledProjects, 'manual', manualProjectOrder),
    [labelledProjects, manualProjectOrder],
  );
  const editingProject = labelledProjects.find((project) => project.id === editingProjectId) ?? null;
  const worktreeDialogProject = labelledProjects.find((project) => project.id === worktreeDialogProjectId) ?? null;

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleReorderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // The store's own list is the manual order the drag rewrites.
    const fromIndex = projects.findIndex((project) => project.id === active.id);
    const toIndex = projects.findIndex((project) => project.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  };

  // Drag order IS the manual order: offering it under another sort would let
  // the user rearrange a list that is about to be re-sorted anyway. Watched
  // servers are dragged into order on the same surface.
  const canReorderProjects = projects.length > 1 && projectSortOrder === 'manual' && grouping === 'project' && !hasWatchedHosts;
  const canReorderHosts = hasWatchedHosts && hostOrder.runtimeKeys.length > 1;
  const canEditOrder = !query && (canReorderProjects || canReorderHosts);
  const phoneList = { searchQuery: query, setSearchQuery: setQuery, clearSearch, renderList, extraDisplayMenuItems: canEditOrder ? <DropdownMenuItem onClick={() => setEditingOrder(true)}>{t('mobile.sessions.editOrder')}</DropdownMenuItem> : null };

  const doneEditingButton = editingOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('mobile.sessions.doneEditing')}
      aria-pressed
      onClick={() => setEditingOrder(false)}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="check" className="size-4" />
    </Button>
  ) : null;

  const empty = projects.length === 0 && !hasChats && !hasWatchedHosts;

  // flex-1 + min-h-0 rather than h-full: both hosts put a fixed-height header
  // above this, so a 100% height overflows by exactly that header — and the
  // clipped overflow swallowed the footer.
  const surfaceContent = (
      <div className="flex min-h-0 flex-1 flex-col">
        {empty ? (
          <div className="min-h-0 flex-1">
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.noProjectsTitle')}
              description={t('mobile.sessions.empty.noProjectsDescription')}
              action={
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 typography-ui-label text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setDirectoryDialogOpen(true)}
                >
                  <Icon name="folder-add" className="size-4" />
                  {t('sessions.sidebar.header.actions.addProject')}
                </button>
              }
            />
          </div>
        ) : null}
        {editingOrder ? (
          <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
            <div className="flex flex-col gap-2 px-3 py-2">
              <p className="px-1 typography-micro text-muted-foreground">{t('mobile.sessions.editOrderHint')}</p>
              {canReorderHosts ? <MobileHostReorderList fallbackLabel={footer?.instanceLabel ?? null} /> : null}
              {canReorderProjects ? <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleReorderDragEnd}>
                <SortableContext items={reorderList.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1.5">
                    {reorderList.map((project) => <SortableProjectRow key={project.id} project={project} />)}
                  </div>
                </SortableContext>
              </DndContext> : null}
            </div>
          </ScrollShadow>
        ) : null}
        {/* Mounted while reordering too, so the list comes back as it was. */}
        <div className={cn('flex min-h-0 flex-1 flex-col', (editingOrder || empty) && 'hidden')}>
          <MobileSidebarActionsProvider value={sidebarActions}>
            <SessionSidebar mobileVariant isVisible={open} phone={phoneList} />
          </MobileSidebarActionsProvider>
        </div>

        {/* App-level footer: the connected instance (Capacitor) on the left;
            on the right the pages opened less often behind "More", then the
            overview and Settings.
            Settings is the one filled button; the rest are flat, as the
            header's. Bottom placement keeps the header for list actions and
            stays thumb-reachable. */}
        {footer ? (
          <div
            className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 pt-1.5"
            style={{ paddingBottom: 'calc(0.375rem + var(--oc-safe-area-bottom, 0px))' }}
          >
            <div className="flex min-w-0 items-center">
              {footerInstanceLabel && footer.onOpenInstances ? (
                <Button
                  type="button"
                  variant="info"
                  size="lg"
                  className="min-w-0 shrink justify-start"
                  onClick={footer.onOpenInstances}
                  aria-label={t('mobile.menu.instances')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <HostMark host={activeHost} defaultIcon="server" className="size-[18px]" />
                  <span className="block min-w-0 truncate">{footerInstanceLabel}</span>
                </Button>
              ) : null}
            </div>
            <SidebarFooter onOpenSettings={footer.onOpenSettings} onOpenShortcuts={footer.onOpenSettings} onOpenAbout={footer.onOpenSettings} moreMenuItems={null} pageActions={{ overview: footer.onOpenOverview, usage: footer.onOpenUsage, scheduled: footer.onOpenScheduled, archive: footer.onOpenArchive }} />
          </div>
        ) : null}

        <DirectoryExplorerDialog open={directoryDialogOpen} onOpenChange={setDirectoryDialogOpen} />
        <NewWorktreeDialog
          open={newWorktreeDialogOpen}
          onOpenChange={(value) => {
            setNewWorktreeDialogOpen(value);
            if (!value) setWorktreeDialogProjectId(null);
          }}
          project={worktreeDialogProject ? { id: worktreeDialogProject.id, path: normalizePath(worktreeDialogProject.path) } : undefined}
          onWorktreeCreated={(worktreePath) => {
            openNewSessionDraft({
              selectedProjectId: worktreeDialogProjectId,
              directoryOverride: worktreePath,
              preserveDirectoryOverride: true,
            });
            close();
          }}
        />
        <MobileProjectEditSurface
          open={editingProject !== null}
          project={editingProject}
          onClose={() => setEditingProjectId(null)}
        />
        {worktreeToDelete ? (
          <MobileDeleteWorktreeDialog
            open
            project={worktreeToDelete.project}
            worktree={worktreeToDelete.worktree}
            onClose={() => setWorktreeToDelete(null)}
          />
        ) : null}
      </div>
  );

  if (variant === 'sidebar') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {editingOrder ? <div className="flex justify-end p-2">{doneEditingButton}</div> : null}
        {surfaceContent}
      </div>
    );
  }

  return (
    <MobileSessionsDrawerContainer
      open={open}
      openDragRef={openDragRef}
      onClose={close}
      // The mirror of the swipe that opened the drawer closes it again —
      // except while a row has its actions out: then the same swipe is the
      // user putting those away, so it only clears them.
      onSwipeClose={() => {
        const rows = useMobileSidebarRowsStore.getState();
        if (rows.revealedKey) {
          rows.setRevealed(rows.revealedKey, false);
          return;
        }
        close();
      }}
      ariaLabel={t('mobile.sessions.sheet.title')}
    >
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('mobile.surface.closeAria')}
          onClick={close}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
        <div className="ms-auto flex shrink-0 items-center gap-2">{doneEditingButton}</div>
      </div>
      {surfaceContent}
    </MobileSessionsDrawerContainer>
  );
};

const DRAWER_ROOT_ID = 'mobile-surface-root';
const DRAWER_BACKDROP_OPACITY = 0.35;
// Slightly long, decelerating slide — matches the workspace drawer so both
// sides feel like the same piece of chrome.
const DRAWER_ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Full-width left drawer for the phone sessions list: covers the whole app
    and slides in from the left edge. Closes via the header X, a right-edge
    swipe back toward the left (the mirror of the gesture that opened it),
    Escape, or the Android back button (handled by MobileShell).

    Stays MOUNTED while closed (parked off-screen, hidden): the sessions
    sheet's project/worktree state stays warm, so reopening shows the tree
    instantly instead of refetching from scratch — and the close slide can
    actually play instead of the drawer vanishing on unmount. */
const MobileSessionsDrawerContainer: React.FC<{
  open: boolean;
  onClose: () => void;
  /** What the closing edge swipe does; the drawer's owner may want it to undo
      a lighter state first. Falls back to `onClose`. */
  onSwipeClose?: () => void;
  openDragRef?: React.RefObject<DrawerDragControl | null>;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ open, onClose, onSwipeClose, openDragRef, ariaLabel, children }) => {
  const { direction } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const drawerRef = React.useRef<HTMLElement>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const onSwipeCloseRef = React.useRef(onSwipeClose);
  React.useEffect(() => {
    onSwipeCloseRef.current = onSwipeClose;
  }, [onSwipeClose]);

  // Swipe from the drawer's end edge back toward its start = close, the
  // reverse of the start-edge swipe that opened it from the chat. Rows inside
  // reveal their actions in the opposite direction, so the two never fight.
  const closeFromEdge = () => (onSwipeCloseRef.current ?? onCloseRef.current)();
  const [dragProgress, setDragProgress] = React.useState<number | null>(null);
  const openRef = React.useRef(open);
  openRef.current = open;
  const hideTimerRef = React.useRef(0);
  const progressFor = React.useCallback((distance: number) => {
    const width = drawerRef.current?.clientWidth || window.innerWidth;
    return Math.min(1, Math.max(0, distance / width));
  }, []);
  const hideAfterSlide = React.useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!openRef.current) setVisible(false);
    }, DRAWER_ENTER_DURATION_MS + 40);
  }, []);
  React.useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  const openDrag = React.useMemo<DrawerDragControl>(() => ({
    follow: (distance) => setDragProgress(progressFor(distance)),
    settle: (nextOpen) => {
      setDragProgress(null);
      setVisible(true);
      setEntered(nextOpen);
      if (!nextOpen) hideAfterSlide();
    },
  }), [hideAfterSlide, progressFor]);
  React.useEffect(() => {
    if (!openDragRef) return;
    openDragRef.current = openDrag;
    return () => {
      openDragRef.current = null;
    };
  }, [openDrag, openDragRef]);

  const closeDrag = React.useMemo<DrawerDragControl>(() => ({
    follow: (distance) => setDragProgress(1 - progressFor(distance)),
    settle: () => setDragProgress(null),
  }), [progressFor]);
  useEdgeSwipe(drawerRef, {
    enabled: open,
    ...(direction === 'rtl'
      ? { onLeftEdgeSwipe: closeFromEdge, onLeftEdgeDrag: closeDrag }
      : { onRightEdgeSwipe: closeFromEdge, onRightEdgeDrag: closeDrag }),
  });

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      let frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setEntered(true));
      });
      return () => window.cancelAnimationFrame(frame);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), DRAWER_ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isIMECompositionEvent(event)) onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!rootRef.current) return null;

  const dragging = dragProgress !== null;
  const closedShift = direction === 'rtl' ? 100 : -100;
  const transform = dragging
    ? `translateX(${(1 - dragProgress) * closedShift}%)`
    : entered ? 'none' : `translateX(${closedShift}%)`;
  const duration = dragging || prefersReducedMotion() ? 0 : DRAWER_ENTER_DURATION_MS;
  const shown = visible || dragging;

  return createPortal(
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 bg-black"
        style={{
          opacity: (dragging ? dragProgress : entered ? 1 : 0) * DRAWER_BACKDROP_OPACITY,
          transition: `opacity ${duration}ms ${DRAWER_EASING}`,
          visibility: shown ? 'visible' : 'hidden',
        }}
      />
      <section
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-hidden={!open}
        className="oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
        style={{
          paddingTop: 'var(--oc-safe-area-top, 0px)',
          // Settled state drops the transform entirely so the drawer isn't kept
          // on a compositing layer (iOS clips those to the safe-area viewport).
          transform,
          transition: `transform ${duration}ms ${DRAWER_EASING}`,
          visibility: shown ? 'visible' : 'hidden',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          {children}
        </div>
      </section>
    </>,
    rootRef.current,
  );
};

const MobileSessionsEmpty: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="typography-ui-label text-foreground">{title}</p>
    {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </div>
);

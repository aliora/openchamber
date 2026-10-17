import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import { useSessionDisplayStore, type SessionStatusFilter } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  handleOpenDirectoryDialog: () => void;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  /** Hides the field and drops its query. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAll: () => void;
  expandAll: () => void;
};

const PRESSED_BUTTON_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';
const IDLE_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-transparent';

const STATUS_FILTER_OPTIONS = [
  ['all', 'sessions.sidebar.header.statusFilter.all'],
  ['attention', 'sessions.sidebar.header.statusFilter.attention'],
  ['running', 'sessions.sidebar.header.statusFilter.running'],
] as const satisfies readonly (readonly [SessionStatusFilter, I18nKey])[];

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showSectionControls,
    handleOpenDirectoryDialog,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    openSessionSearch,
    closeSessionSearch,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAll,
    expandAll,
  } = props;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);
  const statusFilter = useSessionDisplayStore((state) => state.sessionStatusFilter);
  const setStatusFilter = useSessionDisplayStore((state) => state.setSessionStatusFilter);

  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);
  const showWorkSection = useSessionDisplayStore((state) => state.showWorkSection);
  const setShowWorkSection = useSessionDisplayStore((state) => state.setShowWorkSection);
  const showPinnedSection = useSessionDisplayStore((state) => state.showPinnedSection);
  const setShowPinnedSection = useSessionDisplayStore((state) => state.setShowPinnedSection);
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const worktreeSortOrder = useSessionDisplayStore((state) => state.worktreeSortOrder);
  const setWorktreeSortOrder = useSessionDisplayStore((state) => state.setWorktreeSortOrder);
  const sidebarViewMode = useSessionDisplayStore((state) => state.sidebarViewMode);
  const setSidebarViewMode = useSessionDisplayStore((state) => state.setSidebarViewMode);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  // VS Code has no mode switch and always renders the projects view.
  const timelineView = showProjectDisplayControls && sidebarViewMode === 'timeline';
  // The timeline always lists every project, so the grouped view's
  // single-project choice does not apply there.
  const isSingleProjectMode = showProjectDisplayControls && !timelineView && projectDisplayMode === 'single';

  // One choice per line, rarely touched orders behind submenus that name the
  // current choice, so the menu stays short: selection first, then the view,
  // its orders, the sections, and collapse.
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const choiceSubmenu = <T extends string>(
    labelKey: I18nKey,
    options: readonly (readonly [T, I18nKey])[],
    current: T,
    onSelect: (value: T) => void,
  ) => {
    const currentLabelKey = options.find(([value]) => value === current)?.[1];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex-1">{t(labelKey)}</span>
          {currentLabelKey ? <span className="ms-4 text-muted-foreground">{t(currentLabelKey)}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[160px]">
          {options.map(([value, optionLabelKey]) => (
            <DropdownMenuItem key={value} onClick={() => onSelect(value)} className="flex items-center justify-between">
              <span>{t(optionLabelKey)}</span>
              {current === value ? checkMark : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const toggleItem = (labelKey: I18nKey, checked: boolean, onToggle: () => void) => (
    <DropdownMenuItem onClick={onToggle} className="flex items-center justify-between">
      <span>{t(labelKey)}</span>
      {checked ? checkMark : null}
    </DropdownMenuItem>
  );
  const displayMenuSections: React.ReactNode[] = [
    <DropdownMenuItem key="add-project" onClick={handleOpenDirectoryDialog} className="flex items-center gap-2">
      <Icon name="folder-add" className="h-4 w-4" />
      <span>{t('sessions.sidebar.header.actions.addProject')}</span>
    </DropdownMenuItem>,
    <DropdownMenuItem key="select" onClick={toggleSelectionMode} className="flex items-center gap-2">
      <Icon name="checkbox-multiple" className="h-4 w-4" />
      <span>{selectionModeEnabled
        ? t('sessions.sidebar.header.actions.exitSelection')
        : t('sessions.sidebar.header.actions.selectSessions')}</span>
    </DropdownMenuItem>,
  ];
  if (showProjectDisplayControls) {
    displayMenuSections.push(<>
      <DropdownMenuLabel>{t('sessions.sidebar.header.viewMode.label')}</DropdownMenuLabel>
      {([
        ['projects', 'sessions.sidebar.header.viewMode.projects'],
        ['timeline', 'sessions.sidebar.header.viewMode.timeline'],
      ] as const).map(([mode, labelKey]) => (
        <DropdownMenuItem
          key={mode}
          onClick={() => {
            setSidebarViewMode(mode);
            void updateDesktopSettings({ sidebarViewMode: mode });
          }}
          className="flex items-center justify-between"
        >
          <span>{t(labelKey)}</span>
          {sidebarViewMode === mode ? checkMark : null}
        </DropdownMenuItem>
      ))}
    </>);
  }
  // The list view keeps projects in the manual order and has no worktree
  // groups; VS Code groups by workspace only, so it sorts projects alone.
  if (!timelineView) {
    displayMenuSections.push(<>
      {choiceSubmenu('sessions.sidebar.header.actions.sortProjects', [
        ['manual', 'sessions.sidebar.header.projectSort.manual'],
        ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
        ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
        ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
        ['recent', 'sessions.sidebar.header.projectSort.recent'],
      ] as const, projectSortOrder, (order) => {
        setProjectSortOrder(order);
        void updateDesktopSettings({ sidebarProjectSortOrder: order });
      })}
      {showProjectDisplayControls ? choiceSubmenu('sessions.sidebar.header.actions.sortWorktrees', [
        ['recent', 'sessions.sidebar.header.worktreeSort.recent'],
        ['manual', 'sessions.sidebar.header.projectSort.manual'],
        ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
      ] as const, worktreeSortOrder, (order) => {
        setWorktreeSortOrder(order);
        void updateDesktopSettings({ sidebarWorktreeSortOrder: order });
      }) : null}
      {showProjectDisplayControls ? choiceSubmenu('sessions.sidebar.header.projectDisplay.label', [
        ['all', 'sessions.sidebar.header.projectDisplay.all'],
        ['single', 'sessions.sidebar.header.projectDisplay.single'],
      ] as const, projectDisplayMode, (mode) => {
        setProjectDisplayMode(mode);
        void updateDesktopSettings({ sidebarProjectDisplayMode: mode });
      }) : null}
    </>);
  }
  if (showSectionControls) {
    displayMenuSections.push(<>
      {toggleItem('sessions.sidebar.header.displayMode.showChats', showChatsSection, () => {
        setShowChatsSection(!showChatsSection);
        void updateDesktopSettings({ sidebarShowChatsSection: !showChatsSection });
      })}
      {toggleItem('sessions.sidebar.header.displayMode.showPinned', showPinnedSection, () => {
        setShowPinnedSection(!showPinnedSection);
        void updateDesktopSettings({ sidebarShowPinnedSection: !showPinnedSection });
      })}
      {sessionWorkEnabled ? toggleItem('sessions.sidebar.header.displayMode.showWork', showWorkSection, () => {
        setShowWorkSection(!showWorkSection);
        void updateDesktopSettings({ sidebarShowWorkSection: !showWorkSection });
      }) : null}
      {/* List rows always carry two lines; Tree keeps Pinned and In work on one unless asked. */}
      {!timelineView ? toggleItem('sessions.sidebar.header.displayMode.detailedZoneRows', detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      }) : null}
    </>);
  }
  if (!isSingleProjectMode) {
    displayMenuSections.push(<>
      <DropdownMenuItem onClick={collapseAll} className="flex items-center gap-2">
        <Icon name="contract-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={expandAll} className="flex items-center gap-2">
        <Icon name="expand-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
      </DropdownMenuItem>
    </>);
  }

  if (hideDirectoryControls) {
    // VS Code: the sidebar is always a single workspace, so project/directory
    // controls stay hidden, but session search is still useful. Show a compact,
    // always-visible search input at the top of the sessions list.
    return (
      <div className="select-none flex-shrink-0 px-2.5 py-1.5">
        <SessionSearchInput
          inputRef={sessionSearchInputRef}
          value={sessionSearchQuery}
          onSearch={setSessionSearchQuery}
          onClose={closeSessionSearch}
          placeholder={t('sessions.sidebar.header.search.placeholder')}
          clearLabel={t('sessions.sidebar.header.search.clear')}
          leadingHint={hasSessionSearchQuery
            ? (searchMatchCount === 1
              ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
              : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
            : undefined}
          trailingHint={t('sessions.sidebar.header.search.escapeHint')}
        />
      </div>
    );
  }

  const statusFilterLabelKey = STATUS_FILTER_OPTIONS.find(([value]) => value === statusFilter)?.[1] ?? 'sessions.sidebar.header.statusFilter.all';
  const filtered = statusFilter !== 'all';

  // One row: the status filter at the start, the list's own controls at the
  // end. The pages the sidebar opens live in the footer. The search field
  // opens under the row and closes with its toggle.
  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    // ms-[3px] puts the first glyph 16px from the sidebar
                    // edge, in line with the titlebar controls.
                    'ms-[3px] inline-flex h-6 min-w-0 max-w-[12rem] items-center gap-1 rounded-md px-1 typography-ui-label focus-visible:outline-none',
                    filtered ? PRESSED_BUTTON_CLASS : IDLE_BUTTON_CLASS,
                  )}
                  data-status-filter={statusFilter}
                >
                  <Icon name="filter-3" className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t(statusFilterLabelKey)}</span>
                  <Icon name="arrow-down-s" className="h-3.5 w-3.5 shrink-0" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.statusFilter.label')}</p></TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-[160px]">
            {STATUS_FILTER_OPTIONS.map(([value, labelKey]) => (
              <DropdownMenuItem key={value} onClick={() => setStatusFilter(value)} className="flex items-center justify-between">
                <span>{t(labelKey)}</span>
                {statusFilter === value ? checkMark : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={isSessionSearchOpen ? closeSessionSearch : openSessionSearch}
                className={cn(headerActionButtonClass, isSessionSearchOpen ? PRESSED_BUTTON_CLASS : IDLE_BUTTON_CLASS)}
                aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                aria-expanded={isSessionSearchOpen}
              >
                <Icon name="search" className={headerActionIconClass} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.searchSessions')}</p></TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(headerActionButtonClass, IDLE_BUTTON_CLASS)}
                    aria-label={t('sessions.sidebar.header.displayMode.label')}
                  >
                    <Icon name="equalizer-2" className={headerActionIconClass} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              {displayMenuSections.map((section, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {section}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isSessionSearchOpen ? (
        <div className="pb-1">
          <SessionSearchInput
            inputRef={sessionSearchInputRef}
            value={sessionSearchQuery}
            onSearch={setSessionSearchQuery}
            onClose={closeSessionSearch}
            placeholder={t('sessions.sidebar.header.search.placeholder')}
            clearLabel={t('sessions.sidebar.header.search.clear')}
            leadingHint={hasSessionSearchQuery
              ? (searchMatchCount === 1
                ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
              : undefined}
            trailingHint={t('sessions.sidebar.header.search.escapeHint')}
          />
        </div>
      ) : null}
    </div>
  );
}

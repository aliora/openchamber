import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';
import { ACTIVITY_ICON, ACTIVITY_TITLE_KEY } from './sessionSidebarActivityLabels';

export const SessionSidebarActivityHeader: React.FC<{
  activityKey: SessionSidebarActivityKey;
  collapsed: boolean;
  forceExpanded: boolean;
  /** Sessions in the zone, shown after its title. */
  count?: number;
  onToggle: () => void;
}> = ({ activityKey, collapsed, forceExpanded, count, onToggle }) => {
  const { t } = useI18n();
  // One header for every zone, so zones line up with the project headers.
  return <div className={cn('-ms-2.5 -me-2', activityKey === 'scheduled' && 'mt-1.5 border-t border-border/60')}>
    <button
      type="button"
      onClick={forceExpanded ? undefined : onToggle}
      disabled={forceExpanded}
      className="group flex w-full items-center gap-1.5 py-1 ps-4 pe-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      aria-expanded={!collapsed}
    >
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
        <Icon name={ACTIVITY_ICON[activityKey]} className={cn('h-3.5 w-3.5 text-muted-foreground', !forceExpanded && 'group-hover:hidden')} />
        {!forceExpanded ? <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span> : null}
      </span>
      {/* The size of project headers: zones and projects are sections of equal weight. */}
      <span className="typography-ui-section font-bold text-foreground">
        {t(ACTIVITY_TITLE_KEY[activityKey])}
      </span>
      {count !== undefined ? (
        <span dir="auto" className="typography-micro tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </button>
  </div>;
};

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useUIStore } from '@/stores/useUIStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  showRuntimeButtons?: boolean;
};

const footerButtonClassName = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none';
const pressedFooterButtonClassName = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';

/**
 * A button for a page the sidebar opens in the main area. It stays pressed
 * while its page is open, and the same click closes the page again.
 */
function FooterPageButton({ label, icon, pressed, onClick }: {
  label: string;
  icon: IconName;
  pressed: boolean;
  onClick: () => void;
}): React.ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(footerButtonClassName, pressed && pressedFooterButtonClassName)}
          aria-label={label}
          aria-pressed={pressed}
        >
          <Icon name={icon} className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}><p>{label}</p></TooltipContent>
    </Tooltip>
  );
}

/**
 * The sidebar's bottom row: Settings and the pages the sidebar opens (Usage,
 * Scheduled tasks, Archive) as buttons, everything used less
 * often (Integrations, extension pages, Shortcuts, About) in a "More" menu so
 * the row never wraps.
 */
export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  showRuntimeButtons = true,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const guestPages = useGuestPages();
  // The bundled catalog offers outside services; enterprise mode waits for
  // administrator-curated sources instead.
  const enterpriseMode = useEnterpriseMode();
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveOpen = useUIStore((state) => state.isArchivePageOpen);
  const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);

  if (!showRuntimeButtons) {
    return null;
  }

  // The More button reads as pressed while a page it holds is open.
  const morePageOpen = (!enterpriseMode && isIntegrationsCatalogOpen) || guestPages.some((guest) => guest.id === openGuestPageId);
  const checkMark = <Icon name="check" className="ms-auto h-4 w-4 text-primary" />;
  const moreMenu = (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(footerButtonClassName, morePageOpen && pressedFooterButtonClassName)}
              aria-label={t('sessions.sidebar.footer.actions.more')}
            >
              <Icon name="more-2" className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.more')}</p></TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
        {enterpriseMode ? null : (
          <DropdownMenuItem onClick={() => useUIStore.getState().setIntegrationsCatalogOpen(!isIntegrationsCatalogOpen)}>
            <Icon name="store-2" className="h-4 w-4" />
            <span>{t('integrationsCatalog.sidebar.open')}</span>
            {isIntegrationsCatalogOpen ? checkMark : null}
          </DropdownMenuItem>
        )}
        {guestPages.length > 0 ? <>
          {enterpriseMode ? null : <DropdownMenuSeparator />}
          <DropdownMenuLabel>{t('sessions.sidebar.header.actions.extensionPages')}</DropdownMenuLabel>
          {guestPages.map((guest) => {
            const open = openGuestPageId === guest.id;
            return (
              <DropdownMenuItem key={guest.id} onClick={() => useUIStore.getState().setOpenGuestPage(open ? null : guest.id)}>
                <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className="size-4" />
                <span>{guest.pageTitle ?? guest.name}</span>
                {open ? checkMark : null}
              </DropdownMenuItem>
            );
          })}
        </> : null}
        {enterpriseMode && guestPages.length === 0 ? null : <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onOpenShortcuts}>
          <Icon name="command" className="h-4 w-4" />
          <span>{t('sessions.sidebar.footer.actions.shortcuts')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenAbout}>
          <Icon name="information" className="h-4 w-4" />
          <span>{t('sessions.sidebar.footer.actions.aboutOpenChamber')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={onOpenSettings} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.settings')}>
            <Icon name="settings-3" className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.settings')}</p></TooltipContent>
      </Tooltip>
      <FooterPageButton
        label={t('usageStats.openAction')}
        icon="bar-chart"
        pressed={isUsageOpen}
        onClick={() => useUIStore.getState().setUsageStatsPageOpen(!isUsageOpen)}
      />
      <FooterPageButton
        label={t('sessions.sidebar.header.actions.scheduledTasks')}
        icon="calendar-schedule"
        pressed={isScheduledOpen}
        onClick={() => useUIStore.getState().setScheduledTasksDialogOpen(!isScheduledOpen)}
      />
      <FooterPageButton
        label={t('sessions.sidebar.nav.archive')}
        icon="archive"
        pressed={isArchiveOpen}
        onClick={() => useUIStore.getState().setArchivePageOpen(!isArchiveOpen)}
      />
      {moreMenu}
    </div>
  );
}

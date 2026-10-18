import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { Icon } from '@/components/icon/Icon';
import { useKeybinds } from '@/hooks/useKeybind';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  resolveCurrentDesktopHost,
  withLocalDesktopHost,
} from '@/lib/desktopCurrentHost';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  className?: string;
};

/**
 * The instance switcher. Instances only exist in the desktop app; everywhere
 * else there is nothing to switch, so nothing renders.
 */
export function DesktopInstanceMenu({ className }: Props): React.ReactNode {
  const [isDesktopApp] = React.useState(() => isDesktopShell());
  if (!isDesktopApp) {
    return null;
  }
  return <DesktopInstanceMenuContent className={className} />;
}

function DesktopInstanceMenuContent({ className }: Props): React.ReactNode {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const [open, setOpen] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    try {
      if (isDesktopLocalOriginActive()) {
        setCurrentInstanceLabel('Local');
        return;
      }

      // Same resolution the host switcher's own header uses, so the button and
      // the panel it opens can never disagree about which instance this is.
      const cfg = await desktopHostsGet();
      const resolved = resolveCurrentDesktopHost(withLocalDesktopHost(cfg.hosts, cfg.localOrigin));

      if (resolved.id === LOCAL_HOST_ID) {
        setCurrentInstanceLabel('Local');
        return;
      }

      setCurrentInstanceLabel(redactSensitiveUrl(resolved.label.trim() || 'Instance'));
    } catch {
      setCurrentInstanceLabel('Local');
    }
  }, []);

  React.useEffect(() => {
    void refreshCurrentInstanceLabel();
    // Switching instances does not remount the sidebar, so without this the
    // button would keep naming the instance the window left behind.
    return subscribeRuntimeEndpointChanged(() => {
      void refreshCurrentInstanceLabel();
    });
  }, [refreshCurrentInstanceLabel]);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      void refreshCurrentInstanceLabel();
    }
  }, [refreshCurrentInstanceLabel]);

  useKeybinds({
    toggle_services_menu: () => {
      if (open) {
        setOpen(false);
        return;
      }
      // The trigger lives in the sidebar footer; a collapsed sidebar has to
      // come back first, or the menu would anchor to a zero-width column.
      const ui = useUIStore.getState();
      if (!ui.isSidebarOpen) {
        ui.setSidebarOpen(true);
      }
      handleOpenChange(true);
    },
  });

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides));

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('header.services.openWithCurrent', { current: currentInstanceLabel })}
              className={className}
            >
              <Icon name="server" className="h-4 w-4 shrink-0" />
              <span className="truncate typography-ui-label">{currentInstanceLabel}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <p>
            {t('header.services.tooltip.currentInstance', {
              current: currentInstanceLabel,
              toggle: toggleShortcut,
            })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-0"
      >
        <DesktopHostSwitcherDialog
          embedded
          open={open}
          onOpenChange={() => {}}
          onHostSwitched={() => setOpen(false)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

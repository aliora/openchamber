import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { publishTitlebarControlsWidth } from './titlebarControlsWidth';
import { ICON_BUTTON_CLASS, NewSessionSplitButton } from './NewSessionMenu';


/**
 * Persistent titlebar controls at the start of the line (app menu on frameless
 * chrome + sidebar toggle): top left, or top right in a right-to-left locale.
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so the buttons never migrate / re-mount between the
 * two while the sidebar animates open or closed — the panels slide *underneath*
 * a fixed control cluster instead. Its height tracks `--oc-header-height` and
 * its start padding clears the OS window controls via `--oc-titlebar-start-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * onto the elements that reserve room for it (`titlebarControlsWidth.ts`), so
 * the header can reserve matching space when the sidebar is collapsed.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t, locale, direction } = useI18n();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
      locale,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, [locale]);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      publishTitlebarControlsWidth(width);
    };

    publishWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      data-titlebar-left-controls=""
      className="app-region-no-drag absolute inset-s-0 top-0 z-30 flex select-none items-center pe-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingInlineStart: 'var(--oc-titlebar-start-inset, 0.75rem)',
        // The overlay floats above the sidebar rather than inside it, so it is
        // sized by its own content: the icon buttons and the "New session" label
        // are rem-sized and grow with Interface Font Size, while the sidebar and
        // the macOS window-controls clearance are fixed pixels. Left uncapped the
        // cluster runs past the sidebar edge and paints over the chat pane, so
        // cap it here and let the label truncate.
        maxWidth: isSidebarOpen ? 'var(--oc-left-sidebar-width, 100%)' : undefined,
      }}
    >
      <div ref={clusterRef} className="flex min-w-0 items-center gap-2">
        {usesFramelessChrome && windowControlsSide === getInlineStartSide(direction) ? (
          <WindowsWindowControls visible position={windowControlsSide} />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              data-sidebar-toggle=""
              aria-label={t('header.actions.openSessionsAria')}
              aria-pressed={isSidebarOpen}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0', isSidebarOpen && 'text-foreground')}
            >
              <Icon name="layout-left" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        {/* Collapses to an icon so the cluster stays compact over the
            header while the sidebar is closed. */}
        <NewSessionSplitButton labelled={isSidebarOpen} />
      </div>
    </div>
  );
};

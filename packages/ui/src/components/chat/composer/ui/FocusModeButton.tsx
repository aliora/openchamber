/** Expands the composer to fill the surface (desktop focus mode), and shrinks it back. */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import {
    formatShortcutForDisplay,
    getEffectiveShortcutCombo,
} from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

type FocusModeButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isExpandedInput: boolean;
    onToggle: () => void;
};

export const FocusModeButton = React.memo(function FocusModeButton(props: FocusModeButtonProps) {
    const { footerIconButtonClass, iconSizeClass, isExpandedInput, onToggle } = props;
    const { t } = useI18n();
    const expandInputShortcutOverride = useUIStore((state) => state.shortcutOverrides.expand_input);
    const expandInputCombo = getEffectiveShortcutCombo(
        'expand_input',
        expandInputShortcutOverride === undefined ? undefined : { expand_input: expandInputShortcutOverride },
    );
    const shortcut = expandInputCombo ? formatShortcutForDisplay(expandInputCombo) : null;
    const label = isExpandedInput ? t('chat.composer.expand.shrink') : t('chat.composer.expand.expand');

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        isExpandedInput
                            ? 'text-primary'
                            : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    )}
                    onMouseDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={onToggle}
                    // A toggle keeps one name; aria-pressed says whether it is on.
                    aria-label={t('chat.composer.expand.expand')}
                    aria-pressed={isExpandedInput}
                >
                    <Icon name="fullscreen" className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{label}</span>
                    {shortcut ? <span className="opacity-60">{shortcut}</span> : null}
                </div>
            </TooltipContent>
        </Tooltip>
    );
});

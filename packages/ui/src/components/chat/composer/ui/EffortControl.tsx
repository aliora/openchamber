/**
 * The composer's Effort menu: how much the model thinks before it answers,
 * as the model's own effort levels (its variants) in plain words, each with a
 * one-line description. On a server with engines the engine names its default
 * effort, which the list marks instead of offering a separate "Default" item,
 * and picking it records that level, so the session always runs on the level
 * the menu shows. Elsewhere the list starts with "Default", the model's own
 * choice. A model without levels, or Auto, shows the control disabled with
 * the reason instead of the menu.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { describeEffortLevel } from './controlOptionText';

// The radio value of the "Default" item, which records no level.
const DEFAULT_ITEM = '\u0000default';

const TRIGGER_CLASS = 'flex min-w-0 items-center gap-1 rounded-md select-none cursor-pointer text-foreground hover:opacity-70 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:opacity-50 focus-visible:bg-[var(--interactive-hover)]';

interface EffortControlProps {
    levels: readonly string[];
    /** The level picked for the next message; undefined while "Default" or nothing was picked. */
    selected: string | undefined;
    /** The engine's default effort when the model offers it; null on a server without engines. */
    defaultLevel: string | null;
    /** Why no level can be picked, or null when the menu is offered. */
    unavailableReason: string | null;
    /** Undefined picks "Default". */
    onSelect: (level: string | undefined) => void;
    heightClass: string;
    iconSizeClass: string;
    textClass: string;
}

export const EffortControl = React.memo(function EffortControl(props: EffortControlProps) {
    const { levels, selected, defaultLevel, unavailableReason, onSelect, heightClass, iconSizeClass, textClass } = props;
    const { t } = useI18n();

    if (unavailableReason !== null) {
        return (
            <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        aria-disabled="true"
                        className={cn(TRIGGER_CLASS, heightClass)}
                        aria-label={`${t('chat.composer.effort.title')}: ${unavailableReason}`}
                        data-testid="composer-effort-control"
                    >
                        <Icon name="brain-ai-3" className={cn(iconSizeClass, 'flex-shrink-0 text-muted-foreground')} aria-hidden="true" />
                        <span className={cn('model-controls__variant-label truncate font-medium text-muted-foreground', textClass)}>
                            {t('chat.composer.effort.title')}
                        </span>
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                    <p className="typography-meta max-w-[240px]">{unavailableReason}</p>
                </TooltipContent>
            </Tooltip>
        );
    }

    const foldsDefault = defaultLevel !== null && levels.includes(defaultLevel);
    const shownLevel = selected ?? (foldsDefault ? defaultLevel : undefined);
    const shownLabel = shownLevel ? describeEffortLevel(t, shownLevel).label : t('chat.modelControls.default');

    return (
        <Tooltip delayDuration={600}>
            <DropdownMenu>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={cn('model-controls__variant-trigger', TRIGGER_CLASS, heightClass)}
                            aria-label={t('chat.composer.effort.triggerAria', { level: shownLabel })}
                            data-testid="composer-effort-control"
                        >
                            <Icon name="brain-ai-3" className={cn(iconSizeClass, 'flex-shrink-0')} aria-hidden="true" />
                            <span className={cn('model-controls__variant-label truncate max-w-[140px] font-medium', textClass)}>
                                {shownLabel}
                            </span>
                            <Icon name="arrow-down-s" className="size-3.5 flex-shrink-0 opacity-60" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent side="top" align="end" className="w-[min(300px,calc(100vw-2rem))] overflow-y-auto">
                    <DropdownMenuLabel>{t('chat.composer.effort.title')}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={shownLevel ?? DEFAULT_ITEM}>
                        {foldsDefault ? null : (
                            <>
                                <DropdownMenuRadioItem
                                    value={DEFAULT_ITEM}
                                    label={t('chat.modelControls.default')}
                                    closeOnClick
                                    onClick={() => onSelect(undefined)}
                                >
                                    <span className="typography-ui-label font-medium text-foreground">{t('chat.modelControls.default')}</span>
                                </DropdownMenuRadioItem>
                                {levels.length > 0 ? <DropdownMenuSeparator /> : null}
                            </>
                        )}
                        {levels.map((level) => {
                            const text = describeEffortLevel(t, level);
                            return (
                                <DropdownMenuRadioItem
                                    key={level}
                                    value={level}
                                    label={text.label}
                                    closeOnClick
                                    onClick={() => onSelect(level)}
                                    className="py-1.5"
                                >
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="flex flex-wrap items-center gap-x-1.5">
                                            <span className="typography-ui-label font-medium text-foreground">{text.label}</span>
                                            {foldsDefault && level === defaultLevel ? (
                                                <span className="typography-micro text-muted-foreground">{t('chat.composer.effort.modelDefault')}</span>
                                            ) : null}
                                        </span>
                                        {text.description ? (
                                            <span className="typography-micro text-muted-foreground">{text.description}</span>
                                        ) : null}
                                    </span>
                                </DropdownMenuRadioItem>
                            );
                        })}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
            <TooltipContent side="top">
                <div className="flex max-w-[260px] flex-col gap-0.5">
                    <span className="typography-meta font-medium">{t('chat.composer.effort.triggerAria', { level: shownLabel })}</span>
                    <span className="typography-micro opacity-80">{t('chat.composer.effort.tooltip')}</span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});

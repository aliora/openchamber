/**
 * The composer's Permission menu on a server whose sessions run on engines:
 * what the session's CLI may do without asking. The trigger names the mode in
 * force; below the composer's width threshold only its icon and chevron stay
 * (`.composer-footer__control-label` in index.css) and the tooltip and the
 * accessible name carry the mode. Each item is the mode's plain name with a
 * one-line description; a dangerous mode is marked, and a mode that reaches
 * the CLI only with the next prompt says so. On mobile the same list opens as
 * a bottom sheet: a sheet in the shared overlay root keeps the expanded
 * composer from folding back into the pill while the list is open.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { EnginePermissionModeOption } from '@/stores/useEngineControlsStore';
import type { ComposerPermission } from '../state/useComposerPermission';
import { describePermissionMode } from './controlOptionText';

// One icon per mode, so the trigger still tells the modes apart once its label collapses.
const MODE_ICONS: ReadonlyMap<string, IconName> = new Map([
    ['claude.manual', 'shield-user'],
    ['claude.acceptEdits', 'file-edit'],
    ['claude.plan', 'list-check-2'],
    ['claude.auto', 'shield-star'],
    ['claude.dontAsk', 'lock'],
    ['codex.read-only', 'eye'],
    ['codex.untrusted', 'shield-user'],
    ['codex.on-request', 'shield'],
    ['codex.never', 'shield-check'],
    ['antigravity.default', 'eye'],
    ['antigravity.accept-edits', 'file-edit'],
    ['antigravity.auto', 'shield-star'],
]);

const modeIcon = (engine: string, mode: EnginePermissionModeOption): IconName => {
    if (mode.dangerous) return 'error-warning';
    return MODE_ICONS.get(`${engine}.${mode.id}`) ?? 'shield';
};

/** Chrome-less like the model and effort triggers beside it; the label collapses on narrow rows. */
const TRIGGER_CLASS = 'flex min-w-0 items-center gap-1 rounded-md select-none cursor-pointer text-foreground hover:opacity-70 disabled:cursor-default disabled:opacity-50 disabled:hover:opacity-50 focus-visible:bg-[var(--interactive-hover)]';

interface ModeOptionProps {
    engine: string;
    option: EnginePermissionModeOption;
    /** Set when no mode reaches the CLI live: the list then carries the note once. */
    noneLive: boolean;
}

/** One mode as the menu and the sheet list it: icon, name, warning, description, timing. */
const ModeOption = ({ engine, option, noneLive }: ModeOptionProps) => {
    const { t } = useI18n();
    const text = describePermissionMode(t, option);
    return (
        <>
            <Icon
                name={modeIcon(engine, option)}
                className={cn('mt-0.5 size-4 flex-shrink-0', option.dangerous ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}
                aria-hidden="true"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="typography-ui-label font-medium text-foreground">{text.label}</span>
                    {option.dangerous ? (
                        <span className="typography-micro rounded px-1 bg-[var(--status-warning-background)] text-[var(--status-warning-text)]">
                            {t('chat.composer.permission.dangerous')}
                        </span>
                    ) : null}
                </span>
                {text.description ? (
                    <span className="typography-micro text-muted-foreground">{text.description}</span>
                ) : null}
                {!option.appliesLive && !noneLive ? (
                    <span className="typography-micro text-muted-foreground">{t('chat.composer.permission.appliesNextMessage')}</span>
                ) : null}
            </span>
        </>
    );
};

interface EnginePermissionControlProps {
    permission: Exclude<ComposerPermission, { kind: 'shield' }>;
    isMobile: boolean;
    /** The footer's control height and text size. */
    heightClass: string;
    iconSizeClass: string;
    textClass: string;
}

export const EnginePermissionControl = React.memo(function EnginePermissionControl(props: EnginePermissionControlProps) {
    const { permission, isMobile, heightClass, iconSizeClass, textClass } = props;
    const { t } = useI18n();
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const closeSheet = React.useCallback(() => setSheetOpen(false), []);

    if (permission.kind === 'pending') {
        return (
            <button
                type="button"
                disabled
                className={cn(TRIGGER_CLASS, heightClass)}
                aria-label={t('chat.composer.permission.loading')}
                data-testid="composer-permission-control"
            >
                <Icon name="shield" className={cn(iconSizeClass, 'text-muted-foreground')} aria-hidden="true" />
            </button>
        );
    }

    const { engine, mode, select } = permission;
    const current = describePermissionMode(t, mode);
    // Codex and Antigravity take every mode only when their next process
    // starts; Claude only bypass, which then carries the note itself.
    const noneLive = engine.permissionModes.every((option) => !option.appliesLive);

    const triggerClass = cn(TRIGGER_CLASS, heightClass, mode.dangerous && 'text-[var(--status-warning)]');
    const triggerLabel = t('chat.composer.permission.triggerAria', { mode: current.label });
    const triggerContent = (
        <>
            <Icon name={modeIcon(engine.engine, mode)} className={cn(iconSizeClass, 'flex-shrink-0')} aria-hidden="true" />
            <span className={cn('composer-footer__control-label truncate max-w-[180px] font-medium', textClass)}>
                {current.label}
            </span>
            <Icon name="arrow-down-s" className="size-3.5 flex-shrink-0 opacity-60" aria-hidden="true" />
        </>
    );
    const noteForAll = noneLive ? (
        <p className="px-2 pb-1 pt-1.5 typography-micro text-muted-foreground">
            {t('chat.composer.permission.appliesNextMessage')}
        </p>
    ) : null;

    if (isMobile) {
        return (
            <>
                <button
                    type="button"
                    className={triggerClass}
                    aria-label={triggerLabel}
                    aria-haspopup="dialog"
                    aria-expanded={sheetOpen}
                    onClick={() => setSheetOpen(true)}
                    data-testid="composer-permission-control"
                >
                    {triggerContent}
                </button>
                <MobileOverlayPanel open={sheetOpen} onClose={closeSheet} title={t('chat.composer.permission.title')}>
                    <div className="flex flex-col gap-1.5">
                        {engine.permissionModes.map((option) => {
                            const selected = option.id === mode.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    aria-pressed={selected}
                                    className={cn(
                                        'flex w-full items-start gap-2 rounded-xl border px-2 py-1.5 text-start',
                                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                        selected ? 'border-border bg-interactive-selection text-interactive-selection-foreground' : 'border-border/40'
                                    )}
                                    onClick={() => {
                                        if (!selected) select(option.id);
                                        closeSheet();
                                    }}
                                >
                                    <ModeOption engine={engine.engine} option={option} noneLive={noneLive} />
                                    {selected ? <Icon name="check" className="mt-0.5 size-4 flex-shrink-0 text-inherit" aria-hidden="true" /> : null}
                                </button>
                            );
                        })}
                    </div>
                    {noteForAll}
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <Tooltip delayDuration={600}>
            <DropdownMenu>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={triggerClass}
                            aria-label={triggerLabel}
                            data-testid="composer-permission-control"
                        >
                            {triggerContent}
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent side="top" align="start" className="w-[min(340px,calc(100vw-2rem))] overflow-y-auto">
                    <DropdownMenuLabel>{t('chat.composer.permission.title')}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={mode.id}>
                        {engine.permissionModes.map((option) => (
                            <DropdownMenuRadioItem
                                key={option.id}
                                value={option.id}
                                label={describePermissionMode(t, option).label}
                                closeOnClick
                                onClick={() => {
                                    if (option.id !== mode.id) select(option.id);
                                }}
                                className="py-1.5"
                            >
                                <ModeOption engine={engine.engine} option={option} noneLive={noneLive} />
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                    {noteForAll}
                </DropdownMenuContent>
            </DropdownMenu>
            <TooltipContent side="top">
                <div className="flex max-w-[260px] flex-col gap-0.5">
                    <span className="typography-meta font-medium">{current.label}</span>
                    <span className="typography-micro opacity-80">{t('chat.composer.permission.tooltip')}</span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});

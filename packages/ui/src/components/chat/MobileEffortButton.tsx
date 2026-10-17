import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isAutoModel } from '@/lib/routing/autoModel';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { engineDefaultEffortFor, useEngineControlsStore } from '@/stores/useEngineControlsStore';
import { describeEffortLevel } from './composer/ui/controlOptionText';

interface MobileEffortButtonProps {
    onOpenEffort: () => void;
    className?: string;
}

/**
 * The phone composer's Effort control, beside the model button: the level the
 * next message runs at, opening the effort sheet. A model without levels, and
 * Auto, show nothing here; the sheet would offer no choice.
 */
export const MobileEffortButton: React.FC<MobileEffortButtonProps> = ({ onOpenEffort, className }) => {
    const { t } = useI18n();
    const providerId = useConfigStore((state) => state.currentProviderId);
    const modelId = useConfigStore((state) => state.currentModelId);
    // Joined so the selector answers the same value while the levels stay the same.
    const levelsKey = useConfigStore((state) => state.getCurrentModelVariants().join('\u0000'));
    const override = useConfigStore((state) => state.currentVariantSelection.override);
    const inherited = useConfigStore((state) => state.currentVariant);
    const catalog = useEngineControlsStore((state) => state.catalog);

    const levels = levelsKey ? levelsKey.split('\u0000') : [];
    if (levels.length === 0 || isAutoModel(providerId, modelId)) return null;

    // The same reading as the desktop Effort menu: an explicit pick, an
    // explicit "Default" (null), else the inherited level.
    const picked = override === null ? undefined : override ?? inherited;
    const shown = picked ?? engineDefaultEffortFor(catalog, providerId, levels) ?? undefined;
    const label = shown ? describeEffortLevel(t, shown).label : t('chat.modelControls.default');

    return (
        <button
            type="button"
            onClick={onOpenEffort}
            // Same guard as the model button: keep the tap from dismissing the keyboard.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
            className={cn(
                'inline-flex h-[26px] min-h-0 min-w-0 flex-shrink-0 items-center gap-1 rounded-lg',
                'typography-micro font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                className,
            )}
            aria-label={t('chat.composer.effort.triggerAria', { level: label })}
        >
            <Icon name="brain-ai-3" className="size-4 flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
        </button>
    );
};

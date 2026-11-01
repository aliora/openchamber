import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { cn } from '@/lib/utils';

import { ACTIVE_HOST_OPTION_ID } from '../state/draftHost';
import { DraftHostLabel } from './DraftTargetSelectors';

/** Names the host this session runs on, so it stays visible where the host cannot be picked. */
export function ComposerHostChip({ className }: { className?: string }) {
    const { activeHost } = useMonitoredHosts();
    return (
        <span className={cn('flex min-w-0 max-w-[28vw] items-center px-1.5 typography-ui-label text-muted-foreground sm:max-w-[12rem]', className)}>
            <DraftHostLabel option={{ id: activeHost?.id ?? ACTIVE_HOST_OPTION_ID, descriptor: activeHost, watched: null }} />
        </span>
    );
}

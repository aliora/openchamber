import React from 'react';
import type { ReasoningPart as ReasoningPartData } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { parseAntigravityActivityTrace, type AntigravityToolActivity } from '@/lib/opencode/antigravityActivity';
import { getToolIcon } from './toolPresentation';
import ReasoningPart from './ReasoningPart';
import type { StreamPhase } from '../types';

type Props = {
    part: ReasoningPartData;
    messageId: string;
    streamPhase?: StreamPhase;
    showReasoningTraces: boolean;
};

const STATUS_KEY = {
    running: 'chat.antigravityActivity.status.running',
    completed: 'chat.antigravityActivity.status.completed',
    error: 'chat.antigravityActivity.status.error',
} as const;

const TOOL_ALIAS: Record<string, string> = {
    run_command: 'shell',
    write_to_file: 'write',
    read_file: 'read',
    list_dir: 'ls',
    list_files: 'ls',
};

const statusStyle = {
    running: { color: 'var(--status-info)' },
    completed: { color: 'var(--status-success)' },
    error: { color: 'var(--status-error)' },
} as const;

const ActivityRow = React.memo(({ activity }: { activity: AntigravityToolActivity }) => {
    const { t } = useI18n();
    const statusLabel = t(STATUS_KEY[activity.status]);
    const normalizedTool = TOOL_ALIAS[activity.tool.toLowerCase()] ?? activity.tool.toLowerCase();
    const toolLabel = activity.tool.replace(/[_-]+/g, ' ');

    return (
        <div
            className="oc-static-tool-row my-0.5 flex min-h-8 w-full min-w-0 items-center gap-x-2 rounded-xl px-2 py-1.5"
            data-antigravity-activity-id={activity.id}
            data-antigravity-activity-status={activity.status}
            role="status"
            aria-label={`${toolLabel}: ${statusLabel}`}
        >
            <span className="inline-flex h-5 flex-shrink-0 items-center" style={{ color: 'var(--tools-icon)' }}>
                {getToolIcon(normalizedTool)}
            </span>
            <span className="typography-meta flex-shrink-0 font-medium" style={{ color: 'var(--tools-title)' }}>
                {toolLabel}
            </span>
            <span className="inline-flex flex-shrink-0 items-center gap-1 typography-meta" style={statusStyle[activity.status]}>
                {activity.status === 'running' ? (
                    <span aria-hidden="true" className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                    <Icon name={activity.status === 'completed' ? 'check' : 'close'} className="h-3.5 w-3.5" />
                )}
                {statusLabel}
            </span>
            {activity.summary ? (
                <code className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" dir="ltr" title={activity.summary}>
                    {activity.summary}
                </code>
            ) : null}
            {activity.error ? (
                <span className="min-w-0 flex-1 truncate typography-meta" style={{ color: 'var(--status-error)' }} title={activity.error}>
                    {activity.error}
                </span>
            ) : null}
        </div>
    );
});

const AntigravityActivityPart = React.memo(({ part, messageId, streamPhase, showReasoningTraces }: Props) => {
    const segments = React.useMemo(() => parseAntigravityActivityTrace(part.text), [part.text]);
    const hasActivity = segments.some((segment) => segment.type === 'activity');

    if (!hasActivity) {
        return showReasoningTraces ? <ReasoningPart part={part} messageId={messageId} streamPhase={streamPhase} /> : null;
    }

    return (
        <>
            {segments.map((segment, index) => {
                if (segment.type === 'activity') {
                    return <ActivityRow key={`agy-activity-${segment.activity.id}`} activity={segment.activity} />;
                }
                if (!showReasoningTraces || !segment.text.trim()) return null;
                const reasoningPart = { ...part, id: `${part.id}:agy-thought:${index}`, text: segment.text };
                return (
                    <ReasoningPart
                        key={reasoningPart.id}
                        part={reasoningPart}
                        messageId={messageId}
                        streamPhase={streamPhase}
                    />
                );
            })}
        </>
    );
});

AntigravityActivityPart.displayName = 'AntigravityActivityPart';

export default AntigravityActivityPart;

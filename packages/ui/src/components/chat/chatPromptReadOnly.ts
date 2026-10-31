import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    readOnly: boolean,
): boolean => {
    // Review sessions are independent conversations even if an older server or
    // cached record still carries parentID. Their explicit metadata is the
    // authority; only the surface itself may make them read-only.
    if (isReviewSession(session)) {
        return readOnly;
    }

    // A child session (a subagent, a dispatched session) takes prompts like any
    // other, also in a side-panel tab persisted as read-only before it could.
    if (session?.parentID) {
        return false;
    }

    return readOnly;
};

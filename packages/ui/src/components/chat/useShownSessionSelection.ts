import React from 'react';

type SessionSelection = { sessionId: string | null; directory: string | null; hostKey: string };

/**
 * The selection the chat column renders: a deferred copy of `target`, so a
 * session switch paints its cheap reactions first while the previous
 * conversation stays on screen (sync/DOCUMENTATION.md, "Session switch commit").
 *
 * A selection arriving from nothing is taken at once. Leaving a draft or an
 * empty chat has no conversation to keep, and a deferred null beside the draft
 * the store has already closed read as "nothing selected": the column fell
 * back to its empty state for a commit and remounted, composer and work-status
 * card included.
 *
 * A selection of another host is taken at once too. The deferred one names the
 * host the window just left, and the column would ask the newly focused host
 * for that session and its messages, which it does not have.
 */
export const useShownSessionSelection = <T extends SessionSelection>(target: T): T => {
    const deferred = React.useDeferredValue(target);
    if (deferred.hostKey !== target.hostKey) return target;
    return deferred.sessionId === null && target.sessionId !== null ? target : deferred;
};

import { getSessionAutoResume, type SessionAutoResume } from '@/lib/sessionAutoResume';
import { useSessionSelector } from '@/sync/sync-context';

const sameState = (left: SessionAutoResume | null, right: SessionAutoResume | null): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

/** The session's auto-resume state, re-rendering only when it changes. */
export const useSessionAutoResume = (sessionId: string, directory?: string): SessionAutoResume | null => (
  useSessionSelector(sessionId, directory, getSessionAutoResume, sameState)
);

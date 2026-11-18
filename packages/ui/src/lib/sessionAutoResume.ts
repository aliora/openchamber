import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import type { HostRequest } from '@/lib/hosts/host-transport';

/**
 * Automatic resume after a usage limit, stored under
 * `session.metadata.openchamber.autoResume`. The shape and the timer are owned
 * by `packages/web/server/lib/engine/auto-resume.js`; the UI reads the state
 * and changes it only through `POST /api/session/:id/auto-resume`.
 */
const autoResumeSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(['idle', 'scheduled', 'running', 'failed']).optional(),
  resumeAt: z.number().nullish(),
  resetWindow: z.string().nullish(),
  prompt: z.string().nullish(),
  lastError: z.string().nullish(),
});

export type SessionAutoResume = z.infer<typeof autoResumeSchema>;

const autoResumeNamespace = z.object({ openchamber: z.object({ autoResume: autoResumeSchema }) });

export function getSessionAutoResume(session: Pick<Session, 'metadata'> | null | undefined): SessionAutoResume | null {
  return autoResumeNamespace.safeParse(session?.metadata).data?.openchamber.autoResume ?? null;
}

/** Where a moved session went, under `session.metadata.openchamber.transferredTo` (`session-transfer-routes.js`). */
const transferredToSchema = z.object({
  hostLabel: z.string(),
  runtimeKey: z.string().optional(),
  targetSessionId: z.string(),
  targetDirectory: z.string().optional(),
  transferredAt: z.number(),
});

export type SessionTransferredTo = z.infer<typeof transferredToSchema>;

const transferredNamespace = z.object({ openchamber: z.object({ transferredTo: transferredToSchema }) });

export function getSessionTransferredTo(session: Pick<Session, 'metadata'> | null | undefined): SessionTransferredTo | null {
  return transferredNamespace.safeParse(session?.metadata).data?.openchamber.transferredTo ?? null;
}

export type AutoResumeChange = {
  enabled: boolean;
  resumeAt?: number | null;
  prompt?: string | null;
};

const responseSchema = z.object({ data: autoResumeSchema });
const errorSchema = z.object({ error: z.string() });

export async function setSessionAutoResume(request: HostRequest, sessionId: string, change: AutoResumeChange): Promise<SessionAutoResume> {
  const response = await request(`/api/session/${encodeURIComponent(sessionId)}/auto-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorSchema.safeParse(body).data?.error ?? `auto-resume answered ${response.status}`);
  }
  return responseSchema.parse(body).data;
}

/** `HH:MM` in the user's locale, the form the notice shows. */
export function formatResumeTime(resumeAt: number, locale?: string): string {
  return new Date(resumeAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The next time of day at `HH:MM` after `now`, for the time field: a time
 * already past today means tomorrow. Null for text that is not a time.
 */
export function nextTimeOfDay(value: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** `HH:MM` (24h) of a timestamp, the value an `<input type="time">` takes. */
export function toTimeInputValue(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Mirrors `isQuotaLimitError` in packages/web/server/lib/engine/quota-limit.js.
const USAGE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|usage[ _-]?limit|\bquota\b|hit your (?:usage )?limit|resets? (?:at|in)\b|try again (?:at|in)\b|\bexhausted\b|\boverloaded\b|too many requests/i;

/** Whether an error text reads as a usage, rate or quota limit. */
export function looksLikeUsageLimit(text: string | null | undefined): boolean {
  return text ? USAGE_LIMIT_PATTERN.test(text) : false;
}

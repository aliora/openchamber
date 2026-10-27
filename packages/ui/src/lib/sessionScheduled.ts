import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

const scheduledSchema = z.object({ openchamber: z.object({ kind: z.literal('scheduled') }) });

export const isSessionScheduledInMetadata = (session: Session | null | undefined): boolean => (
  scheduledSchema.safeParse(session?.metadata).success
);

import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const codeCliCompatibilitySchema = z.object({
  state: z.enum(['compatible', 'incompatible', 'unavailable']),
  version: z.string().nullable(),
  installation: z.enum(['managed', 'external', 'bundled']),
  binary: z.string().nullable().optional(),
  minimumVersion: z.string().optional(),
  canInstall: z.boolean(),
});
export type CodeCliCompatibility = z.infer<typeof codeCliCompatibilitySchema>;

export const fetchCodeCliCompatibility = async (force = false): Promise<CodeCliCompatibility> => {
  const query = force ? '?refresh=true' : '';
  const response = await runtimeFetch(`/api/codecli/compatibility${query}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Could not check Code CLI compatibility');
  return codeCliCompatibilitySchema.parse(await response.json());
};

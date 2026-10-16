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

export const recoverCodeCli = async (action: 'install-v2' | 'reconnect' = 'reconnect'): Promise<{ state: 'recovered' } | { state: 'incompatible'; compatibility: CodeCliCompatibility }> => {
  if (action === 'install-v2') {
    const response = await runtimeFetch('/api/codecli/install', { method: 'POST' });
    if (!response.ok) throw new Error('Code CLI installation failed');
    return { state: 'recovered' };
  }
  const compatibility = await fetchCodeCliCompatibility(true);
  if (compatibility.state === 'incompatible') return { state: 'incompatible', compatibility };
  if (compatibility.state === 'unavailable') throw new Error('Could not determine Code CLI compatibility');
  const response = await runtimeFetch('/api/config/reload', { method: 'POST' });
  if (!response.ok) throw new Error('Code CLI recovery failed');
  return { state: 'recovered' };
};

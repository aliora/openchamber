import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { EngineId, EngineStatus, Readiness } from './engineSetupModel';

const engineIdSchema = z.enum(['claude', 'codex', 'antigravity']);

const engineStatusSchema = z.object({
  engine: engineIdSchema,
  displayName: z.string(),
  providerID: z.string(),
  installed: z.boolean(),
  version: z.string().nullable().catch(null),
  latestVersion: z.string().nullable().catch(null),
  updateAvailable: z.boolean().catch(false),
  canInstall: z.boolean(),
  installCommand: z.string(),
  state: z.enum(['idle', 'installing', 'completed', 'failed']).catch('idle'),
  lastError: z.string().nullable().catch(null),
});

const enginesResponseSchema = z.object({ data: z.array(engineStatusSchema.nullable().catch(null)) });

const readinessResponseSchema = z.object({
  data: z.array(z.object({
    engine: engineIdSchema,
    state: z.enum(['unknown', 'ready', 'not-installed', 'signed-out']).catch('unknown'),
    fixCommand: z.string().nullable().catch(null),
  }).nullable().catch(null)),
});

export const fetchEngineStatuses = async (): Promise<EngineStatus[]> => {
  const response = await runtimeFetch('/api/engines');
  if (!response.ok) throw new Error(`Engine list request failed (${response.status})`);
  const { data } = enginesResponseSchema.parse(await response.json());
  return data.filter((entry): entry is EngineStatus => entry !== null);
};

export const fetchReadinessByEngine = async (): Promise<Map<EngineId, { state: Readiness; fixCommand: string | null }>> => {
  const response = await runtimeFetch('/api/engines/readiness');
  if (!response.ok) throw new Error(`Engine readiness request failed (${response.status})`);
  const { data } = readinessResponseSchema.parse(await response.json());
  return new Map(data.flatMap((entry) => (entry ? [[entry.engine, { state: entry.state, fixCommand: entry.fixCommand }] as const] : [])));
};

export const startEngineInstall = async (engine: EngineId): Promise<void> => {
  const response = await runtimeFetch(`/api/engines/${engine}/install`, { method: 'POST' });
  if (!response.ok) throw new Error(`Install request failed (${response.status})`);
};

export const startEngineLogin = async (engine: EngineId): Promise<{ ok: boolean; message: string | null }> => {
  const response = await runtimeFetch(`/api/engines/${engine}/auth/login`, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, message: typeof body.error === 'string' ? body.error : null };
};

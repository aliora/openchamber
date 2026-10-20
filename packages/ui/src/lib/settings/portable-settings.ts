import { z } from 'zod';

export const PORTABLE_CATEGORIES = ['mcp', 'agents', 'commands', 'skills', 'gitIdentities', 'projects', 'scheduledTasks'] as const;

export type PortableCategory = (typeof PORTABLE_CATEGORIES)[number];

export type PortableValue = z.infer<ReturnType<typeof z.json>>;

export type PortableRef = { category: PortableCategory; key: string };

export type PortableRequest = (path: string, init?: RequestInit) => Promise<Response>;

const itemSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  detail: z.string().optional(),
  fingerprint: z.string().min(1),
  updatedAt: z.number().nullable(),
  paths: z.array(z.string()).catch([]),
});

export type PortableItem = z.infer<typeof itemSchema>;

const categorySnapshotSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(itemSchema) }),
  z.object({ status: z.literal('error') }),
]);

const snapshotSchema = z.object({
  categories: z.partialRecord(z.enum(PORTABLE_CATEGORIES), categorySnapshotSchema.catch({ status: 'error' })),
});

export type PortableSnapshot = z.infer<typeof snapshotSchema>['categories'];

const refFields = { category: z.enum(PORTABLE_CATEGORIES), key: z.string() };

const exportSchema = z.object({
  items: z.array(z.discriminatedUnion('status', [
    z.object({ ...refFields, status: z.literal('found'), value: z.json(), updatedAt: z.number().nullable() }),
    z.object({ ...refFields, status: z.literal('missing') }),
    z.object({ ...refFields, status: z.literal('refused'), reason: z.string() }),
    z.object({ ...refFields, status: z.literal('failed'), reason: z.string() }),
  ])),
});

export type PortableExport = z.infer<typeof exportSchema>['items'][number];

export type PortableImportItem = PortableRef & { value: PortableValue; updatedAt: number | null };

export type PortableRemoval = PortableRef & { updatedAt: number | null };

const importResultSchema = z.object({
  ...refFields,
  status: z.enum(['applied', 'removed', 'unchanged', 'skipped', 'refused', 'failed']),
  reason: z.string().optional(),
  path: z.string().optional(),
});

export type PortableImportResult = z.infer<typeof importResultSchema>;

const importResponseSchema = z.object({ results: z.array(importResultSchema) });

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

const readJson = async <T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> => {
  if (!response.ok) throw new Error(`${what} failed (${response.status})`);
  return schema.parse(await response.json());
};

export const fetchPortableSnapshot = async (request: PortableRequest): Promise<PortableSnapshot> => {
  const response = await request('/api/portable-settings', { headers: { Accept: 'application/json' } });
  return (await readJson(response, snapshotSchema, 'Reading shared settings')).categories;
};

export const exportPortableItems = async (request: PortableRequest, refs: readonly PortableRef[]): Promise<PortableExport[]> => {
  const response = await request('/api/portable-settings/export', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ items: refs }) });
  return (await readJson(response, exportSchema, 'Reading shared settings')).items;
};

export const importPortableItems = async (
  request: PortableRequest,
  changes: { items: readonly PortableImportItem[]; removals: readonly PortableRemoval[]; force: boolean },
): Promise<PortableImportResult[]> => {
  const response = await request('/api/portable-settings', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(changes) });
  return (await readJson(response, importResponseSchema, 'Writing shared settings')).results;
};

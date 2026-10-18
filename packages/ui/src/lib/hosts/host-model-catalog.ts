import { z } from 'zod';

import type { ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import type { HostRequest } from './host-transport';

const listSchema = z.object({ data: z.array(z.unknown()) });

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  activation: z.string().optional(),
}).passthrough();

const modelSchema = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().catch(false),
}).passthrough();

const readList = async <T,>(request: HostRequest, path: string, schema: z.ZodType<T>): Promise<T[]> => {
  const response = await request(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  const { data } = listSchema.parse(await response.json());
  return data.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

/**
 * The providers and models a host offers, grouped as the model picker reads
 * them, by the same rule the config store applies to the active host's catalog.
 */
export const fetchHostModelProviders = async (request: HostRequest): Promise<ModelPickerProvider[]> => {
  const models = await readList(request, '/api/model', modelSchema);
  const providers = await readList(request, '/api/provider', providerSchema);
  const modelsByProvider = new Map<string, Array<z.infer<typeof modelSchema>>>();
  for (const model of models) {
    if (!model.enabled) continue;
    const normalized = { ...model, variants: Array.isArray(model.variants) ? model.variants : [] };
    const bucket = modelsByProvider.get(model.providerID);
    if (bucket) bucket.push(normalized);
    else modelsByProvider.set(model.providerID, [normalized]);
  }
  return providers
    .filter((provider) => provider.activation !== 'disabled' && modelsByProvider.has(provider.id))
    .map((provider) => ({ id: provider.id, name: provider.name, models: modelsByProvider.get(provider.id) ?? [] }));
};

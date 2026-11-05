import { OpenCodeService } from './service.js';

export const encodeModel = (providerID, id) => [providerID, id].map(encodeURIComponent).join('/');
export const decodeModel = (value) => {
  const pair = value.split('/');
  if (pair.length !== 2 || pair.some((part) => !part)) throw new Error('Invalid OpenCode provider/model identity.');
  return { providerID: decodeURIComponent(pair[0]), id: decodeURIComponent(pair[1]) };
};

const readModels = async (directory, createService) => {
  const service = createService({ cwd: directory });
  try {
    const client = await service.start();
    const options = { location: { directory } };
    const models = await client.model.list(options, { signal: AbortSignal.timeout(15000) });
    const selected = await client.model.default(options, { signal: AbortSignal.timeout(15000) });
    return { models: models.data, defaultModel: selected.data };
  } finally { await service.stop(); }
};

/** Cached per directory; a failed read never becomes an authoritative empty catalog. */
export const createOpenCodeModelCatalog = ({ read, createService = (options) => new OpenCodeService(options), now = Date.now } = {}) => {
  const readCatalog = read ?? ((directory) => readModels(directory, createService));
  const entries = new Map();
  const empty = { models: [], defaultModel: null };
  const current = (directory) => entries.get(directory?.replace(/\\/g, '/'))?.catalog ?? empty;
  const refresh = (directory) => {
    directory = directory.replace(/\\/g, '/');
    const previous = entries.get(directory);
    if (previous?.pending) return previous.pending;
    const entry = previous ?? { catalog: empty, at: 0 };
    entries.set(directory, entry);
    entry.pending = (async () => {
      try {
        const result = await readCatalog(directory);
        const models = result.models.filter((model) => model.enabled !== false).map((model) => ({
          id: encodeModel(model.providerID, model.id), name: `${model.providerID} / ${model.name}`,
          family: model.family, limit: model.limit, efforts: (model.variants ?? []).map((variant) => variant.id),
        }));
        const selected = result.defaultModel ? encodeModel(result.defaultModel.providerID, result.defaultModel.id) : null;
        entry.catalog = { models, defaultModel: models.some((model) => model.id === selected) ? selected : models[0]?.id ?? null };
        entry.at = now();
      } catch (error) {
        entry.catalog = { ...entry.catalog, error: 'OpenCode model discovery failed.' };
        throw error;
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  };
  return {
    current,
    refresh,
    refreshAll: () => Promise.all([...entries.keys()].map(refresh)),
    invalidate: (directory) => { const entry = entries.get(directory.replace(/\\/g, '/')); if (entry) entry.at = 0; },
    ensure: (directory) => {
      const entry = entries.get(directory.replace(/\\/g, '/'));
      return entry && now() - entry.at < 30000 ? Promise.resolve() : refresh(directory);
    },
    hasModels: () => [...entries.values()].some((entry) => entry.catalog.models.length > 0),
  };
};

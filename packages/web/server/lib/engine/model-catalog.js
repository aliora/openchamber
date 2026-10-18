import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const READ_TTL_MS = 10 * 60_000;
const IDENTITY_CHECK_MS = 30_000;

const catalogSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    family: z.string().optional(),
    efforts: z.array(z.string()).optional(),
  })).min(1),
  defaultModel: z.string(),
});

const withListedDefault = (catalog) => (catalog.models.some((model) => model.id === catalog.defaultModel)
  ? catalog
  : { ...catalog, defaultModel: catalog.models[0].id });

const parseStoredCatalog = (value) => {
  const parsed = catalogSchema.safeParse(value);
  return parsed.success ? withListedDefault(parsed.data) : null;
};

const readStoredEntries = (filePath, warn) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`[engine] Could not read the stored model lists: ${error?.message ?? error}`);
    return {};
  }
};

export const createModelCatalogStore = ({ filePath, warn = console.warn }) => {
  let entries = readStoredEntries(filePath, warn);
  let writing = Promise.resolve();

  const write = async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  };

  return {
    load: (engineId) => parseStoredCatalog(entries?.[engineId]),
    save: (engineId, catalog) => {
      entries = { ...entries, [engineId]: catalog };
      writing = writing
        .then(write)
        .catch((error) => warn(`[engine:${engineId}] Could not store the model list: ${error?.message ?? error}`));
      return writing;
    },
  };
};

export const createModelCatalog = ({
  id,
  read,
  identify,
  fallback,
  store = null,
  ttlMs = READ_TTL_MS,
  checkIntervalMs = IDENTITY_CHECK_MS,
  now = Date.now,
  warn = console.warn,
}) => {
  let started = false;
  let served = store?.load(id) ?? fallback;
  let lastRead = null;
  let checkedAt = -Infinity;
  let checking = null;
  const listeners = new Set();

  const serve = (catalog) => {
    const next = withListedDefault(catalog);
    const changed = JSON.stringify(next) !== JSON.stringify(served);
    served = next;
    if (!changed) return;
    void store?.save(id, next);
    for (const listener of listeners) listener(next);
  };

  const readIfStale = async (force) => {
    await new Promise((resolve) => setImmediate(resolve));
    checkedAt = now();
    const identity = identify();
    if (identity === null) return;
    if (!force && lastRead && lastRead.identity === identity && checkedAt - lastRead.at < ttlMs) return;
    lastRead = { identity, at: checkedAt };
    serve(await read());
  };

  const warnFailure = (error) => warn(`[engine:${id}] Could not read the model list: ${error?.message ?? error}`);

  const check = () => {
    checking ??= readIfStale(false)
      .catch(warnFailure)
      .finally(() => { checking = null; });
    return checking;
  };

  return {
    current: () => {
      if (started && now() - checkedAt >= checkIntervalMs) void check();
      return served;
    },
    start: () => {
      started = true;
      return check();
    },
    refresh: async () => {
      if (!started) return served;
      while (checking) await checking;
      checking = readIfStale(true).finally(() => { checking = null; });
      await checking;
      return served;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const modelCatalogMethods = (catalog) => ({
  modelCatalog: catalog.current,
  startModelCatalog: catalog.start,
  refreshModelCatalog: catalog.refresh,
  onModelCatalogChange: catalog.subscribe,
});

export const installedCliIdentity = (installer) => {
  const status = installer.getStatus();
  return status.installed ? `${status.command} ${status.version}` : null;
};

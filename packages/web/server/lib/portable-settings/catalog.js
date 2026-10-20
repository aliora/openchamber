import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { isPlainObject, isString } from '../shared/guards.js';

export const PORTABLE_CATEGORIES = Object.freeze([
  'mcp',
  'agents',
  'commands',
  'skills',
  'gitIdentities',
  'projects',
  'scheduledTasks',
]);

const MAX_KEY_LENGTH = 1024;

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const fingerprintOf = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);

const toForwardSlashes = (value) => value.split(path.sep).join('/');

export const toPortablePath = (absolutePath, home = os.homedir()) => {
  const relative = path.relative(home, absolutePath);
  if (relative === '') return '~';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return toForwardSlashes(absolutePath);
  return `~/${toForwardSlashes(relative)}`;
};

export const expandPortablePath = (portablePath, home = os.homedir()) => {
  if (portablePath === '~') return home;
  if (portablePath.startsWith('~/')) return path.join(home, ...portablePath.slice(2).split('/'));
  return portablePath;
};

const isPortableCategory = (value) => PORTABLE_CATEGORIES.includes(value);

export const isValidPortableKey = (value) => isString(value)
  && value.length > 0
  && value.length <= MAX_KEY_LENGTH
  && !value.includes('\0');

const readUpdatedAt = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

const describeItem = ({ key, label, detail, value, updatedAt, paths }) => {
  const item = { key, label, fingerprint: fingerprintOf(value), updatedAt: readUpdatedAt(updatedAt), paths: paths ?? [] };
  if (detail) item.detail = detail;
  return item;
};

export const createPortableSettingsCatalog = ({ categories, pathExists, expandPath = expandPortablePath, logger = console }) => {
  const adapterOf = (category) => (isPortableCategory(category) ? categories[category] ?? null : null);

  const listMap = async (category) => {
    const items = await adapterOf(category).list();
    return new Map(items.map((item) => [item.key, item]));
  };

  const createListCache = () => {
    const lists = new Map();
    const read = (category) => {
      if (!lists.has(category)) lists.set(category, listMap(category));
      return lists.get(category);
    };
    read.invalidate = (category) => lists.delete(category);
    return read;
  };

  const snapshot = async () => {
    const entries = await Promise.all(PORTABLE_CATEGORIES.filter(adapterOf).map(async (category) => {
      try {
        const items = await adapterOf(category).list();
        return [category, { status: 'ok', items: items.map(describeItem) }];
      } catch (error) {
        logger.warn(`[portable-settings] Could not list ${category}: ${error?.message ?? error}`);
        return [category, { status: 'error' }];
      }
    }));
    return { version: 1, categories: Object.fromEntries(entries) };
  };

  const exportItems = async (refs) => {
    const listOf = createListCache();
    return Promise.all(refs.map(async ({ category, key: requestedKey }) => {
      if (!adapterOf(category)) return { category, key: requestedKey, status: 'missing' };
      const key = (await adapterOf(category).normalizeKey?.(requestedKey)) ?? requestedKey;
      try {
        const item = (await listOf(category)).get(key);
        if (!item) return { category, key, status: 'missing' };
        const refusal = adapterOf(category).exportRefusal?.(item) ?? null;
        if (refusal) return { category, key, status: 'refused', reason: refusal };
        return { category, key, status: 'found', value: item.value, updatedAt: readUpdatedAt(item.updatedAt) };
      } catch (error) {
        logger.warn(`[portable-settings] Could not export ${category} "${key}": ${error?.message ?? error}`);
        return { category, key, status: 'failed', reason: 'error' };
      }
    }));
  };

  const missingPath = async (paths) => {
    for (const portablePath of paths) {
      if (!(await pathExists(expandPath(portablePath)))) return portablePath;
    }
    return null;
  };

  const isOutdated = (current, incomingUpdatedAt, force) => {
    if (force) return false;
    const currentUpdatedAt = readUpdatedAt(current?.updatedAt);
    const incoming = readUpdatedAt(incomingUpdatedAt);
    return currentUpdatedAt !== null && incoming !== null && currentUpdatedAt > incoming;
  };

  const applyItem = async (listOf, { category, key, value, updatedAt }, force) => {
    const adapter = adapterOf(category);
    if (!adapter || !isValidPortableKey(key)) return { category, key, status: 'refused', reason: 'invalid' };
    const parsed = adapter.parse(key, value);
    if (!parsed) return { category, key, status: 'refused', reason: 'invalid' };
    const current = (await listOf(category)).get(key) ?? null;
    const absent = await missingPath(adapter.requiredPaths(key, parsed, current));
    if (absent) return { category, key, status: 'refused', reason: 'path-missing', path: absent };
    if (current && fingerprintOf(current.value) === fingerprintOf(parsed)) return { category, key, status: 'unchanged' };
    if (isOutdated(current, updatedAt, force)) return { category, key, status: 'skipped', reason: 'target-newer' };
    const refusal = (await adapter.writeRefusal?.(key, parsed, current)) ?? null;
    if (refusal) return { category, key, status: 'refused', reason: refusal };
    listOf.invalidate(category);
    await adapter.write(key, parsed, current);
    return { category, key, status: 'applied' };
  };

  const removeItem = async (listOf, { category, key, updatedAt }, force) => {
    const adapter = adapterOf(category);
    if (!adapter || !isValidPortableKey(key)) return { category, key, status: 'refused', reason: 'invalid' };
    const current = (await listOf(category)).get(key) ?? null;
    if (!current) return { category, key, status: 'unchanged' };
    if (isOutdated(current, updatedAt, force)) return { category, key, status: 'skipped', reason: 'target-newer' };
    listOf.invalidate(category);
    await adapter.remove(key, current);
    return { category, key, status: 'removed' };
  };

  const settle = async (category, key, work) => {
    try {
      return await work();
    } catch (error) {
      logger.warn(`[portable-settings] Could not write ${category} "${key}": ${error?.message ?? error}`);
      return { category, key, status: 'failed', reason: 'error' };
    }
  };

  const importItems = async ({ items = [], removals = [], force = false }) => {
    const listOf = createListCache();
    const results = [];
    for (const item of items) {
      results.push(await settle(item.category, item.key, () => applyItem(listOf, item, force)));
    }
    for (const removal of removals) {
      results.push(await settle(removal.category, removal.key, () => removeItem(listOf, removal, force)));
    }
    return results;
  };

  return { snapshot, exportItems, importItems };
};

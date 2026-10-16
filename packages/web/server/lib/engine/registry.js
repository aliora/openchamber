// Every coding CLI OpenChamber can drive registers here as an engine adapter.
// DOCUMENTATION.md in this folder describes the adapter contract.

const REQUIRED_FIELDS = ['id', 'displayName', 'providerID', 'defaultModel', 'defaultPermissionMode'];
const REQUIRED_METHODS = ['createProcess'];

const assertEngineAdapter = (adapter) => {
  for (const field of REQUIRED_FIELDS) {
    if (!adapter?.[field]) {
      throw new Error(`Engine adapter is missing "${field}"`);
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (!(adapter[method] instanceof Function)) {
      throw new Error(`Engine adapter "${adapter.id}" is missing ${method}()`);
    }
  }
  if (!Array.isArray(adapter.models) || adapter.models.length === 0) {
    throw new Error(`Engine adapter "${adapter.id}" has no models`);
  }
  if (!Array.isArray(adapter.permissionModes) || !adapter.permissionModes.includes(adapter.defaultPermissionMode)) {
    throw new Error(`Engine adapter "${adapter.id}" does not list its default permission mode`);
  }
  if (!adapter.installer || !adapter.auth) {
    throw new Error(`Engine adapter "${adapter.id}" is missing installer or auth`);
  }
};

/**
 * The first adapter is the default engine: sessions created without an engine
 * use it, and sessions stored before engines existed belong to it.
 */
export const createEngineRegistry = (adapters) => {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error('At least one engine adapter is required');
  }

  const byId = new Map();
  for (const adapter of adapters) {
    assertEngineAdapter(adapter);
    if (byId.has(adapter.id)) {
      throw new Error(`Engine adapter "${adapter.id}" is registered twice`);
    }
    byId.set(adapter.id, adapter);
  }
  const defaultAdapter = adapters[0];

  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) || null,
    getDefault: () => defaultAdapter,
    // A stored session without an engine predates multi-engine support.
    forSession: (session) => byId.get(session?.engine || defaultAdapter.id) || null,
  };
};

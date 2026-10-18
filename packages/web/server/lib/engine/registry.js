// Every coding CLI OpenChamber can drive registers here as an engine adapter.
// DOCUMENTATION.md in this folder describes the adapter contract.

const REQUIRED_FIELDS = ['id', 'displayName', 'providerID', 'defaultPermissionMode'];
const REQUIRED_METHODS = ['createProcess', 'modelCatalog'];

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
  // An engine that reads its models from its CLI answers its fallback list here.
  const catalog = adapter.modelCatalog();
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error(`Engine adapter "${adapter.id}" has no models`);
  }
  if (!catalog.models.some((model) => model.id === catalog.defaultModel)) {
    throw new Error(`Engine adapter "${adapter.id}" does not list its default model`);
  }
  if (!Array.isArray(adapter.permissionModes) || !adapter.permissionModes.includes(adapter.defaultPermissionMode)) {
    throw new Error(`Engine adapter "${adapter.id}" does not list its default permission mode`);
  }
  // Optional lists that describe some of the modes: each must name modes the adapter has.
  for (const field of ['livePermissionModes', 'dangerousPermissionModes']) {
    const modes = adapter[field] ?? [];
    if (!Array.isArray(modes) || modes.some((mode) => !adapter.permissionModes.includes(mode))) {
      throw new Error(`Engine adapter "${adapter.id}" lists ${field} it does not have`);
    }
  }
  if (!adapter.dangerousPermissionModes?.length) {
    throw new Error(`Engine adapter "${adapter.id}" has no full-permission mode`);
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
  const byProvider = new Map();
  for (const adapter of adapters) {
    if (byProvider.has(adapter.providerID)) {
      throw new Error(`Engine adapters "${byProvider.get(adapter.providerID).id}" and "${adapter.id}" share provider "${adapter.providerID}"`);
    }
    byProvider.set(adapter.providerID, adapter);
  }

  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) || null,
    getDefault: () => defaultAdapter,
    // The UI picks an engine by picking one of its models, so a provider names exactly one engine.
    forProvider: (providerID) => byProvider.get(providerID) || null,
    // A stored session without an engine predates multi-engine support.
    forSession: (session) => byId.get(session?.engine || defaultAdapter.id) || null,
  };
};

import { permissionTier } from './permission-tiers.js';

export const createAgentPermissionControl = ({ store, registry, applyPermissionMode }) => {
  const load = async (sessionId) => {
    const session = await store.getSession(sessionId);
    const adapter = session ? registry.forSession(session) : null;
    return adapter ? { session, adapter } : null;
  };

  const isBelow = async (session, ancestorId) => {
    const visited = new Set();
    let parentId = session.parentID;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = (await store.getSession(parentId))?.parentID;
    }
    return false;
  };

  const callerTier = (caller) => permissionTier(caller.adapter, caller.session.permissionMode);

  const loadCaller = async (callerSessionId) => (await load(callerSessionId)) ?? {
    status: 403,
    error: 'Permission modes can be changed only from a session OpenChamber runs',
  };

  const aboveCaller = (caller, mode) => ({
    status: 403,
    error: `${mode} allows more than this session's own mode (${caller.session.permissionMode}). Pick a mode at or below it; only the user can raise it`,
  });

  const unknownMode = (adapter, mode) => ({
    status: 400,
    error: `Unknown permission mode for ${adapter.displayName}: ${mode}. Use one of: ${adapter.permissionModes.join(', ')}`,
  });

  const setByAgent = async ({ callerSessionId, sessionId, mode }) => {
    const caller = await loadCaller(callerSessionId);
    if (caller.error) return caller;
    if (sessionId === callerSessionId) {
      return { status: 403, error: 'A session cannot change its own permission mode; the user changes it in the composer' };
    }
    const target = await load(sessionId);
    if (!target) return { status: 404, error: `Session not found: ${sessionId}` };
    if (!(await isBelow(target.session, callerSessionId))) {
      return { status: 403, error: `Session ${sessionId} is not a sub-session of this session; an agent changes the mode only of sessions below it` };
    }
    if (!target.adapter.permissionModes.includes(mode)) return unknownMode(target.adapter, mode);
    if (permissionTier(target.adapter, mode) > callerTier(caller)) return aboveCaller(caller, mode);
    const { session } = await applyPermissionMode(target, mode);
    return { sessionId, permissionMode: session.permissionMode };
  };

  const checkNewSubSession = async ({ callerSessionId, mode, providerID }) => {
    const caller = await loadCaller(callerSessionId);
    if (caller.error) return caller;
    const named = providerID ? registry.forProvider(providerID) : null;
    if (named && !named.permissionModes.includes(mode)) return unknownMode(named, mode);
    const engines = (named ? [named] : registry.list()).filter((adapter) => adapter.permissionModes.includes(mode));
    if (engines.length === 0) return { status: 400, error: `Unknown permission mode: ${mode}` };
    if (engines.every((adapter) => permissionTier(adapter, mode) > callerTier(caller))) return aboveCaller(caller, mode);
    return {};
  };

  return { setByAgent, checkNewSubSession };
};

import express from 'express';
import { z } from 'zod';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode as readEnterpriseMode } from '../enterprise-mode.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { EngineSessionRuntime, executionEvent } from './session-runtime.js';
import { toPermissionRequest } from './permission-request.js';
import { formAnswerSchema } from './question-form.js';
import { ENGINE_ACTIONS } from './cli-installer.js';
import { createSessionSummary, streamSessionSummary } from './session-summary.js';
import { describeLocation, describeProjects, readVcs, requestDirectory } from './location.js';
import { historyQuerySchema, readHistoryPage, toWireHistory } from './wire-messages.js';
import { createLoginSessions } from './login-session.js';
import {
  carryPermissionMode,
  createEngineAvailability,
  defaultModelEffort,
  defaultModelInfo,
  listModelInfos,
  modelEfforts,
  toEngineControls,
  toEngineReadiness,
  toProviderInfo,
} from './catalog.js';

// HTTP routes for every registered engine. The singular `/api/session` family
// speaks the OpenCode 2.x wire shape the shared UI reads; the plural
// `/api/sessions` family returns stored records as they are.

/**
 * The session's model as an OpenCode 2.x `ModelRef`. Like an OpenCode
 * record, a model on its default effort carries no `variant` and any other
 * effort is the variant, so the composer shows the effort the session runs on.
 */
const wireModelRef = (session, adapter) => {
  const catalog = adapter.modelCatalog();
  const id = session.model || catalog.defaultModel;
  const model = catalog.models.find((candidate) => candidate.id === id);
  const effort = session.effort;
  const variant = model && effort && effort !== defaultModelEffort(adapter, model) && modelEfforts(adapter, model).includes(effort)
    ? effort
    : undefined;
  return variant ? { providerID: adapter.providerID, id, variant } : { providerID: adapter.providerID, id };
};

const formatWireSession = (session, adapter) => {
  const cwd = session.cwd || process.cwd();
  return {
    ...session,
    engine: adapter.id,
    directory: cwd,
    location: { directory: cwd },
    projectID: session.projectID || 'default',
    agent: adapter.id,
    model: wireModelRef(session, adapter),
    time: { created: session.createdAt || Date.now(), updated: session.updatedAt || Date.now() },
    tokens: session.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: session.cost || 0,
  };
};

const describeCompatibility = (status) => (status.installed
  ? {
    state: 'compatible',
    version: status.version,
    installation: 'external',
    binary: status.command,
    canInstall: true,
  }
  : {
    state: 'incompatible',
    version: null,
    installation: 'external',
    binary: null,
    canInstall: status.canInstall,
  });

const describeEngine = (adapter, force = false) => {
  const status = adapter.installer.getStatus(force);
  return {
    status: 'ok',
    engine: adapter.id,
    displayName: adapter.displayName,
    providerID: adapter.providerID,
    installed: status.installed,
    version: status.version,
    rawVersion: status.rawVersion,
    command: status.command,
    installSource: status.installSource ?? 'unknown',
    actions: { install: false, update: false, uninstall: false, reinstall: false, doctor: false, ...status.actions },
    commands: {
      install: null,
      update: null,
      uninstall: null,
      reinstall: null,
      doctor: null,
      ...status.commands,
      login: adapter.auth.loginCommand ?? null,
      logout: adapter.auth.logoutCommand ?? null,
    },
    packageManager: status.packageManager,
    packageManagerCommand: status.packageManagerCommand,
    canInstall: status.canInstall,
    installCommand: status.installCommand,
    latestVersion: status.latestVersion ?? null,
    updateAvailable: status.updateAvailable ?? false,
    state: status.state,
    action: status.action ?? null,
    lastError: status.lastError,
    detection: status.detection,
  };
};

const streamInstall = (adapter, req, res) => {
  const { installer } = adapter;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  sendEvent('status', installer.getStatus());
  for (const log of installer.getLogs()) {
    sendEvent('log', log);
  }

  const onLog = (entry) => sendEvent('log', entry);
  const onStatus = (entry) => sendEvent('status', entry);
  installer.on('log', onLog);
  installer.on('status', onStatus);
  req.on('close', () => {
    installer.off('log', onLog);
    installer.off('status', onStatus);
  });
};

const startAction = (adapter, action, body, res, onSettled) => {
  if (!ENGINE_ACTIONS.includes(action)) {
    return res.status(404).json({ error: `Unknown action: ${action}` });
  }
  const status = adapter.installer.getStatus(true);
  if (status.state === 'installing') {
    return res.status(409).json({ error: `${adapter.displayName} is busy with ${status.action ?? 'another action'}`, action: status.action ?? null });
  }
  if (!status.actions?.[action]) {
    return res.status(400).json({
      error: `${adapter.displayName} cannot ${action} from OpenChamber`,
      command: status.commands?.[action] ?? (action === 'install' ? status.installCommand ?? null : null),
    });
  }
  adapter.installer.runAction(action, { removeConfig: body?.removeConfig === true })
    .catch((err) => {
      console.error(`[engine:${adapter.id}] Background ${action} error:`, err.message);
    })
    .finally(onSettled);
  return res.status(202).json({ status: 'running', action, message: `${adapter.displayName} ${action} started` });
};

// An engine whose CLI cannot sign out from a server throws the step the user takes instead.
// An action that returns a promise, such as a sign-out that runs the CLI, is answered once it settles.
const runAuthAction = async (res, action, message) => {
  try {
    await action();
    res.json({ success: true, message });
  } catch (err) {
    res.status(501).json({ error: err.message });
  }
};

const loginInputSchema = z.object({ text: z.string().trim().min(1).max(4096) });

// A refused value on a wire route, in OpenCode's 400 shape; `error` stays for
// clients that read the plural routes' shape.
const invalidRequest = ({ error, field }) => ({ _tag: 'InvalidRequestError', message: error, field, error });

// The id the UI mints for a prompt (`ascendingId`); the user message keeps it,
// so the UI's optimistic copy of the prompt reconciles in place.
const promptIdSchema = z.string().regex(/^msg_[0-9A-Za-z]{1,64}$/).nullish();

/**
 * The model, effort and permission mode a create or PATCH body sets, checked
 * against what the engine accepts now, as `{ values }` with only the fields
 * the body set, or `{ error, field }` for a value the engine does not know,
 * so nothing is stored. `currentModel` is the session's model id when the
 * body names none. An effort for a model that offers none is left out: the
 * CLI has nothing to apply it to.
 */
const readSessionSettings = ({ model, effort, permissionMode }, adapter, currentModel) => {
  const values = {};
  const { models } = adapter.modelCatalog();
  if (model !== undefined) {
    if (!models.some((candidate) => candidate.id === model)) {
      return { error: `Unknown model for ${adapter.displayName}: ${String(model)}`, field: 'model' };
    }
    values.model = model;
  }
  const modelInfo = models.find((candidate) => candidate.id === (values.model ?? currentModel));
  const efforts = modelInfo ? modelEfforts(adapter, modelInfo) : [];
  if (effort !== undefined && efforts.length > 0) {
    if (!efforts.includes(effort)) {
      return { error: `Unknown effort for ${adapter.displayName}: ${String(effort)}`, field: 'effort' };
    }
    values.effort = effort;
  }
  if (permissionMode !== undefined) {
    if (!adapter.permissionModes.includes(permissionMode)) {
      return { error: `Unknown permission mode for ${adapter.displayName}: ${String(permissionMode)}`, field: 'permissionMode' };
    }
    values.permissionMode = permissionMode;
  }
  return { values };
};

/**
 * Resolves the prompt options against what the session's engine accepts now,
 * read once from its model catalog. Returns an error string for a value the
 * engine does not know, or an effort the model does not offer.
 */
const resolveTurnOptions = (body, session, adapter) => {
  const catalog = adapter.modelCatalog();
  const modelId = body.model?.id || body.model || session.model || catalog.defaultModel;
  const effort = body.effort || session.effort || adapter.defaultEffort;
  const permissionMode = body.permissionMode || session.permissionMode || adapter.defaultPermissionMode;

  const model = catalog.models.find((candidate) => candidate.id === modelId);
  if (!model && modelId !== session.model) {
    return { error: `Unknown model for ${adapter.displayName}: ${String(modelId)}` };
  }
  // A model that offers no effort, such as Antigravity's `default`, ignores it.
  const efforts = model ? modelEfforts(adapter, model) : [];
  if (effort && efforts.length > 0 && !efforts.includes(effort)) {
    return { error: `Unknown effort for ${adapter.displayName} ${modelId}: ${effort}` };
  }
  if (!adapter.permissionModes.includes(permissionMode)) {
    return { error: `Unknown permission mode for ${adapter.displayName}: ${permissionMode}` };
  }
  return { model: modelId, effort, permissionMode };
};

export const registerEngineRoutes = (app, { registry, ...dependencies }) => {
  const store = dependencies.store || new LocalSessionStore();
  const controlBridge = dependencies.controlBridge || new ControlBridge();
  const streamHub = dependencies.streamHub || new StreamHub();
  const isEnterpriseMode = dependencies.isEnterpriseMode || readEnterpriseMode;
  const refreshModels = async (adapter) => {
    try {
      await adapter.refreshModelCatalog?.();
    } catch (error) {
      console.warn(`[engine:${adapter.id}] Could not refresh the model list: ${error?.message ?? error}`);
    }
  };
  const availability = createEngineAvailability({ onStateChange: refreshModels });
  const loginSessions = createLoginSessions({
    ...dependencies.login,
    onSettled: (adapter) => {
      availability.invalidate(adapter);
      void refreshModels(adapter);
    },
  });
  // Optional: without it, engine processes run without OpenChamber's tools.
  const toolServer = dependencies.toolServer ?? null;
  const runtime = new EngineSessionRuntime({ store, streamHub, controlBridge, toolServer });
  // The managed Chats folders, so the session summary can mark chats.
  const summary = createSessionSummary({
    store,
    registry,
    runtime,
    controlBridge,
    chatRoots: dependencies.chatRoots ?? [],
    readSettings: dependencies.readSettings,
  });
  const defaultEngine = registry.getDefault();
  for (const adapter of registry.list()) {
    adapter.onModelCatalogChange?.(() => {
      streamHub.broadcast('global', { type: 'model.updated', created: Date.now(), data: { engine: adapter.id } });
    });
  }

  app.use('/api', (req, res, next) => {
    if (req.body !== undefined) return next();
    express.json({ limit: '50mb' })(req, res, next);
  });

  // Enterprise mode keeps conversations with the providers the administrator
  // set up, so signing in to one through this server is refused. Signing out
  // still works.
  const startLogin = async (adapter, res) => {
    if (isEnterpriseMode()) {
      return res.status(403).json({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' });
    }
    if (!adapter.auth.loginProcess) {
      const error = adapter.auth.loginCommand
        ? `Run \`${adapter.auth.loginCommand}\` in a terminal on the server to sign in to ${adapter.displayName}.`
        : `${adapter.displayName} cannot sign in from OpenChamber.`;
      return res.status(501).json({ error });
    }
    return res.json(await loginSessions.start(adapter));
  };

  const withEngine = (handler) => (req, res) => {
    const adapter = registry.get(req.params.engine);
    if (!adapter) return res.status(404).json({ error: `Unknown engine: ${req.params.engine}` });
    return handler(adapter, req, res);
  };

  const withOfferedPermissionMode = async (session, adapter) => {
    if (!session.permissionMode || adapter.permissionModes.includes(session.permissionMode)) return session;
    await adapter.startPermissionModeProbe?.();
    if (adapter.permissionModes.includes(session.permissionMode)) return session;
    return store.updateSession(session.id, { permissionMode: adapter.defaultPermissionMode });
  };

  const loadSession = async (req, res) => {
    const session = await store.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const adapter = registry.forSession(session);
    if (!adapter) {
      res.status(409).json({ error: `Session engine is not available: ${session.engine}` });
      return null;
    }
    return { session: await withOfferedPermissionMode(session, adapter), adapter };
  };

  // Engines
  app.get('/api/engines', (req, res) => {
    res.json({ data: registry.list().map((adapter) => describeEngine(adapter)), default: defaultEngine.id });
  });
  // What the model picker greys out: each engine's state from the same checks
  // as `/api/provider`, and the command that fixes one that cannot run. It
  // never waits for a CLI. In enterprise mode a signed-out engine comes
  // without its sign-in command; the mode is read at each request.
  app.get('/api/engines/readiness', (req, res) => {
    const enterpriseMode = isEnterpriseMode();
    res.json({ data: registry.list().map((adapter) => toEngineReadiness(adapter, availability.read(adapter), { enterpriseMode })) });
  });
  // What the composer offers for each engine's sessions: its permission modes
  // and default effort. Built from the adapters alone; it never runs a CLI.
  app.get('/api/engines/controls', (req, res) => {
    res.json({ data: registry.list().map(toEngineControls), default: defaultEngine.id });
  });
  app.get('/api/engines/:engine/status', withEngine((adapter, req, res) => {
    res.json(describeEngine(adapter, req.query.refresh === 'true'));
  }));
  const startEngineAction = (adapter, action, body, res) => startAction(adapter, action, body, res, () => {
    availability.invalidate(adapter);
    void refreshModels(adapter);
  });
  app.post('/api/engines/:engine/actions/:action', withEngine((adapter, req, res) => startEngineAction(adapter, req.params.action, req.body, res)));
  app.post('/api/engines/:engine/install', withEngine((adapter, req, res) => startEngineAction(adapter, 'install', {}, res)));
  app.get('/api/engines/:engine/install/stream', withEngine((adapter, req, res) => streamInstall(adapter, req, res)));
  app.get('/api/engines/:engine/auth/status', withEngine(async (adapter, req, res) => {
    res.json(await adapter.auth.status());
  }));
  app.post('/api/engines/:engine/auth/login', withEngine((adapter, req, res) => startLogin(adapter, res)));
  app.get('/api/engines/:engine/auth/login', withEngine((adapter, req, res) => res.json(loginSessions.get(adapter))));
  app.delete('/api/engines/:engine/auth/login', withEngine(async (adapter, req, res) => res.json(await loginSessions.cancel(adapter))));
  app.post('/api/engines/:engine/auth/login/input', withEngine((adapter, req, res) => {
    const parsed = loginInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Send the code as non-empty text' });
    const session = loginSessions.input(adapter, parsed.data.text);
    if (!session) return res.status(409).json({ error: `No ${adapter.displayName} sign-in is running` });
    return res.json(session);
  }));
  app.post('/api/engines/:engine/auth/logout', withEngine((adapter, req, res) => {
    runAuthAction(res, () => adapter.auth.logout(), 'Logged out').finally(() => {
      availability.invalidate(adapter);
      void refreshModels(adapter);
    });
  }));
  const describeModels = (adapter) => {
    const { models, defaultModel } = adapter.modelCatalog();
    return { engine: adapter.id, providerID: adapter.providerID, models, defaultModel };
  };
  const refreshModelList = async (adapter) => {
    try {
      await adapter.refreshModelCatalog?.();
      return { ...describeModels(adapter), error: null };
    } catch (error) {
      return { ...describeModels(adapter), error: error?.message ?? String(error) };
    }
  };
  app.post('/api/engines/models/refresh', async (req, res) => {
    res.json({ data: await Promise.all(registry.list().map(refreshModelList)) });
  });
  app.post('/api/engines/:engine/models/refresh', withEngine(async (adapter, req, res) => {
    const result = await refreshModelList(adapter);
    res.status(result.error ? 502 : 200).json(result);
  }));

  // Default-engine routes the current UI and desktop shell still call.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', engine: defaultEngine.id, engines: registry.list().map((a) => a.id) });
  });
  app.get('/api/engine/status', (req, res) => res.json(describeEngine(defaultEngine)));
  app.post('/api/engine/install', (req, res) => startEngineAction(defaultEngine, 'install', {}, res));
  app.get('/api/engine/install/stream', (req, res) => streamInstall(defaultEngine, req, res));
  app.get('/api/codecli/compatibility', (req, res) => {
    const force = req.query.refresh === 'true' || req.query.force === 'true';
    const statuses = registry.list().map((adapter) => ({ adapter, status: adapter.installer.getStatus(force) }));
    const chosen = statuses.find(({ status }) => status.installed) ?? statuses.find(({ adapter }) => adapter === defaultEngine);
    res.json(describeCompatibility(chosen.status));
  });
  app.post('/api/codecli/install', async (req, res) => {
    try {
      const result = await defaultEngine.installer.install();
      res.json({ success: true, version: result.version });
    } catch (err) {
      res.status(500).json({ error: err.message || `${defaultEngine.displayName} installation failed` });
    }
  });
  app.get('/api/auth/status', async (req, res) => {
    try {
      res.json(await defaultEngine.auth.status());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/auth/login', (req, res) => startLogin(defaultEngine, res));
  app.post('/api/auth/logout', (req, res) => {
    runAuthAction(res, () => defaultEngine.auth.logout(), 'Logged out');
  });

  app.post('/api/config/reload', (req, res) => {
    res.json({ success: true });
  });
  app.get('/api/info', (req, res) => {
    res.json({ version: defaultEngine.installer.getStatus().version, engine: defaultEngine.id, urls: {}, paths: {} });
  });

  // Catalog routes for UI bootstrap
  // OpenCode 2.x answers `/api/config` with a bare list of config entries, not
  // a `data` envelope; the client folds the list, and every directory's
  // bootstrap fails when it cannot. The model is a `provider/model` reference.
  app.get('/api/config', (req, res) => {
    res.json([{
      type: 'document',
      info: { model: `${defaultEngine.providerID}/${defaultEngine.modelCatalog().defaultModel}` },
    }]);
  });
  // The model picker reads every engine's models, the default engine's default
  // model and one provider per engine, built in catalog.js. No engine's catalog
  // depends on the directory, so it only travels back in `location`.
  const directoryOf = (req) => requestDirectory(req, process.cwd());
  app.get('/api/model', (req, res) => {
    res.json({ location: { directory: directoryOf(req) }, data: listModelInfos(registry) });
  });
  app.get('/api/model/default', (req, res) => {
    res.json({ location: { directory: directoryOf(req) }, data: defaultModelInfo(registry) });
  });
  app.get('/api/provider', (req, res) => {
    res.json({
      location: { directory: directoryOf(req) },
      data: registry.list().map((adapter) => toProviderInfo(adapter, availability.read(adapter).state === 'ready')),
    });
  });

  app.get('/api/integration', (req, res) => {
    res.json({ location: { directory: directoryOf(req) }, data: [] });
  });

  // MCP. Each CLI loads the MCP servers of its own configuration, and
  // OpenChamber adds only its tool server to each engine process. The list
  // names that server. The routes that would change servers answer 400 with
  // a message the UI shows, because the client keeps the body only of a
  // status the route declares.
  const isToolServer = (server) => Boolean(toolServer?.name) && server === toolServer.name;
  const unsupportedMcpChange = (res, server) => res.status(400).json({
    _tag: 'InvalidRequestError',
    message: isToolServer(server)
      ? 'OpenChamber\'s tools stay connected to every engine chat. Turn single tools off in Settings, under OpenChamber Tools.'
      : 'OpenChamber does not manage MCP servers for engine chats. Each CLI loads the MCP servers in its own configuration.',
  });
  app.get('/api/mcp', (req, res) => {
    res.json({
      location: { directory: directoryOf(req) },
      data: toolServer?.name ? [{ name: toolServer.name, status: { status: 'connected' } }] : [],
    });
  });
  // Connecting the tool server, which is already connected, changes nothing.
  app.post('/api/experimental/mcp/:server/connect', (req, res) => (
    isToolServer(req.params.server) ? res.status(204).end() : unsupportedMcpChange(res, req.params.server)
  ));
  app.post('/api/experimental/mcp/:server/disconnect', (req, res) => unsupportedMcpChange(res, req.params.server));
  app.put('/api/experimental/mcp/:server', (req, res) => unsupportedMcpChange(res, req.params.server));
  app.delete('/api/experimental/mcp/:server', (req, res) => unsupportedMcpChange(res, req.params.server));

  app.get('/api/agent', (req, res) => {
    res.json({
      data: registry.list().map((adapter) => ({
        id: adapter.id,
        name: adapter.displayName,
        description: `${adapter.displayName} CLI`,
        mode: 'primary',
        model: { providerID: adapter.providerID, id: adapter.modelCatalog().defaultModel },
      })),
    });
  });
  for (const emptyList of ['/api/skill', '/api/command', '/api/permission/saved', '/api/reference']) {
    app.get(emptyList, (req, res) => res.json({ data: [] }));
  }
  app.get('/api/experimental/session/stats', (req, res) => {
    res.json({ data: {} });
  });

  // Location-scoped reads the UI bootstrap makes for every project directory
  app.get('/api/location', (req, res) => {
    res.json(describeLocation(directoryOf(req)));
  });
  app.get('/api/project', async (req, res) => {
    try {
      res.json(describeProjects(await store.listSessions()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/vcs', async (req, res) => {
    const directory = directoryOf(req);
    res.json({ location: { directory }, data: await readVcs(directory) });
  });
  app.get('/api/form', async (req, res) => {
    try {
      const directory = directoryOf(req);
      const sessions = await store.listSessions({ cwd: directory });
      const ids = new Set(sessions.map((session) => session.id));
      res.json({ location: { directory }, data: controlBridge.getPendingQuestions().filter((form) => ids.has(form.sessionID)) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // Engines run no background shells.
  app.get('/api/shell', (req, res) => {
    res.json({ location: { directory: directoryOf(req) }, data: [] });
  });
  app.get('/api/permission/request', async (req, res) => {
    try {
      const directory = directoryOf(req);
      const sessions = await store.listSessions({ cwd: directory });
      const ids = new Set(sessions.map((session) => session.id));
      const data = controlBridge.getPendingRequests()
        .filter((pending) => ids.has(pending.sessionId))
        .map((pending) => toPermissionRequest(pending.sessionId, pending));
      res.json({ location: { directory }, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sessions
  // A session starts on the engine it names, else on the engine of its model
  // (picking a model picks its engine), else on the default engine. Its
  // effort is the model's variant when the body sends one, as the composer
  // does for a draft.
  const createSession = async (body, cwd) => {
    const adapter = body.engine ? registry.get(body.engine) : registry.forProvider(body.model?.providerID) || defaultEngine;
    if (!adapter) return { error: `Unknown engine: ${body.engine}` };
    const model = body.model?.id || body.model || adapter.modelCatalog().defaultModel;
    const settings = readSessionSettings({
      model,
      effort: body.effort || body.model?.variant || undefined,
      permissionMode: body.permissionMode,
    }, adapter, model);
    if (settings.error) return settings;
    const session = await store.createSession({
      ...body,
      cwd,
      engine: adapter.id,
      model,
      effort: settings.values.effort || adapter.defaultEffort,
      permissionMode: settings.values.permissionMode || adapter.defaultPermissionMode,
    });
    // The agent and model let other clients show the session's engine
    // before they read the full record.
    streamHub.broadcast(session.id, {
      type: 'session.created',
      created: Date.now(),
      data: {
        sessionID: session.id,
        projectID: 'default',
        location: { directory: session.cwd },
        title: session.title,
        agent: adapter.id,
        model: { providerID: adapter.providerID, id: session.model },
      },
    });
    summary.publish(session.id);
    return { session, adapter };
  };

  const deleteSession = async (sessionId) => {
    await runtime.abort(sessionId);
    streamHub.closeSession(sessionId);
    controlBridge.forgetSession(sessionId);
    const deleted = await store.deleteSession(sessionId);
    runtime.forget(sessionId);
    if (deleted) {
      summary.remove(sessionId);
      // Other clients drop the session from their lists only on this event.
      streamHub.broadcast(sessionId, { type: 'session.deleted', created: Date.now(), data: { sessionID: sessionId } });
    }
    return deleted;
  };

  app.get('/api/sessions', async (req, res) => {
    try {
      res.json(await store.listSessions({ cwd: req.query.directory || req.query.cwd || null }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session', async (req, res) => {
    try {
      const cwd = req.query.directory || req.query.cwd || req.headers['x-opencode-directory'] || null;
      const sessions = await store.listSessions({ cwd });
      // A session whose engine is no longer registered stays stored but is not listed.
      const data = sessions.flatMap((session) => {
        const adapter = registry.forSession(session);
        return adapter ? [formatWireSession(session, adapter)] : [];
      });
      // One page holds every session: the store is local and small, so there is no next cursor.
      res.json({ data, cursor: { previous: null, next: null } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/active', (req, res) => {
    const active = {};
    for (const id of runtime.runningSessionIds()) {
      active[id] = { type: 'running' };
    }
    res.json({ data: active });
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createSession(body, body.cwd || process.cwd());
      if (result.error) return res.status(400).json({ error: result.error, field: result.field });
      res.status(201).json(result.session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session', async (req, res) => {
    try {
      const body = req.body || {};
      const cwd = body.location?.directory || req.headers['x-opencode-directory'] || process.cwd();
      const result = await createSession(body, cwd);
      if (result.error) return res.status(400).json(invalidRequest(result));
      res.status(200).json({ data: formatWireSession(result.session, result.adapter) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Registered before `/api/sessions/:id`, which would read `summary` as a session id.
  app.get('/api/sessions/summary', async (req, res) => {
    try {
      res.json(await summary.list());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/sessions/summary/stream', (req, res) => streamSessionSummary(summary, res, {
    heartbeatMs: dependencies.summaryHeartbeatMs,
  }));

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const session = await store.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const adapter = registry.forSession(session);
      res.json(adapter ? await withOfferedPermissionMode(session, adapter) : session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (loaded) res.json({ data: formatWireSession(loaded.session, loaded.adapter) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The engine of a session is fixed at creation: a CLI cannot resume another CLI's transcript.
  // Its engine state is written only by the runtime, so a client cannot point it at another conversation.
  // A model, effort or permission mode the engine does not know is refused before anything is stored.
  const readSessionPatch = (body, { session, adapter }) => {
    const {
      engine: _engine,
      id: _id,
      engineState: _engineState,
      handoff: _handoff,
      model,
      effort,
      permissionMode,
      ...patch
    } = body || {};
    const settings = readSessionSettings(
      { model: model?.id || model, effort, permissionMode },
      adapter,
      session.model || adapter.modelCatalog().defaultModel,
    );
    if (settings.error) return settings;
    return { patch: { ...patch, ...settings.values } };
  };

  // Stores the patch, then hands a new permission mode to the session's live
  // CLI: Claude switches a running process at once, any other change
  // reaches the CLI with the next prompt (`applyPermissionMode`).
  const patchSession = async (loaded, body) => {
    const read = readSessionPatch(body, loaded);
    if (read.error) return read;
    const session = await store.updateSession(loaded.session.id, read.patch);
    if (read.patch.permissionMode) await runtime.applyPermissionMode(loaded.session.id, read.patch.permissionMode);
    summary.publish(loaded.session.id);
    return { session };
  };

  app.patch('/api/sessions/:id', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const result = await patchSession(loaded, req.body);
      if (result.error) return res.status(400).json({ error: result.error, field: result.field });
      res.json(result.session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/session/:id', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const result = await patchSession(loaded, req.body);
      if (result.error) return res.status(400).json(invalidRequest(result));
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const deleted = await deleteSession(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Session not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/session/:id', async (req, res) => {
    try {
      await deleteSession(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session/:id/agent', (req, res) => {
    res.status(204).end();
  });
  const syntheticExtrasSchema = z.object({
    id: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  });
  const pendingSynthetic = new Map();
  const takeSynthetic = (sessionId) => {
    const context = pendingSynthetic.get(sessionId) ?? [];
    pendingSynthetic.delete(sessionId);
    return context;
  };

  app.post('/api/session/:id/synthetic', async (req, res) => {
    try {
      const text = req.body?.text;
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json(invalidRequest({ error: 'Synthetic text is required', field: 'text' }));
      }
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const extras = syntheticExtrasSchema.safeParse(req.body);
      const item = runtime.admitSynthetic(loaded.session.id, { text, ...(extras.success ? extras.data : {}) });
      pendingSynthetic.set(loaded.session.id, [...(pendingSynthetic.get(loaded.session.id) ?? []), item]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The model picker lists every engine's models. Picking another engine's model moves the
  // chat to that engine once no turn is running. A CLI cannot continue another CLI's
  // transcript, so a chat with history is marked for handoff (handoff.js).
  app.post('/api/session/:id/model', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const requested = req.body?.model?.id || req.body?.model;
      const target = registry.forProvider(req.body?.model?.providerID) || loaded.adapter;
      const model = target.modelCatalog().models.find((candidate) => candidate.id === requested);
      if (!model) {
        return res.status(400).json({ error: `Unknown model for ${target.displayName}: ${String(requested)}` });
      }
      const efforts = modelEfforts(target, model);
      const variant = req.body?.model?.variant;
      const effort = efforts.includes(variant) ? variant : undefined;

      if (target.id === loaded.adapter.id) {
        const patch = { model: requested };
        // Without a variant the session keeps its effort, unless the new
        // model does not offer it: Codex models differ in the efforts they take.
        if (effort) patch.effort = effort;
        else if (efforts.length > 0 && !efforts.includes(loaded.session.effort)) patch.effort = target.defaultEffort;
        await store.updateSession(req.params.id, patch);
        return res.status(204).end();
      }

      if (runtime.isTurnActive(req.params.id)) {
        return res.status(409).json({
          error: `${loaded.adapter.displayName} is still answering. Switch to ${target.displayName} once it is done.`,
        });
      }
      const history = await store.getMessages(req.params.id);
      await store.updateSession(req.params.id, {
        engine: target.id,
        model: requested,
        effort: effort || target.defaultEffort,
        permissionMode: carryPermissionMode(loaded.session.permissionMode, loaded.adapter, target),
        engineState: null,
        handoff: history.length > 0 || undefined,
      });
      summary.publish(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Messages
  app.get('/api/sessions/:id/messages', async (req, res) => {
    try {
      res.json(await store.getMessages(req.params.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The OpenCode 2.x message routes (wire-messages.js): stored messages and
  // the answers of turns still running, so a reload mid-turn keeps the turn,
  // a page waiting for the user included.
  const readHistory = async ({ session, adapter }) => toWireHistory({
    stored: await store.getMessages(session.id),
    running: runtime.openMessages(session.id),
    session,
    adapter,
  });

  app.get('/api/session/:id/message', async (req, res) => {
    try {
      const query = historyQuerySchema.safeParse(req.query);
      if (!query.success) {
        return res.status(400).json({ _tag: 'InvalidRequestError', message: z.prettifyError(query.error) });
      }
      // A cursor carries its own order, and OpenCode refuses to be given both.
      if (query.data.cursor !== undefined && query.data.order !== undefined) {
        return res.status(400).json({ _tag: 'InvalidRequestError', message: 'A cursor cannot be combined with an order', field: 'order' });
      }
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const page = readHistoryPage(await readHistory(loaded), query.data);
      if (!page) return res.status(400).json({ _tag: 'InvalidCursorError', message: 'The cursor names no message of this session' });
      res.json({ data: page.data, cursor: { previous: null, next: page.next } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id/message/:messageID', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const { id: sessionID, messageID } = req.params;
      const message = (await readHistory(loaded)).find((candidate) => candidate.id === messageID);
      if (!message) {
        return res.status(404).json({ _tag: 'MessageNotFoundError', sessionID, messageID, message: 'Message not found' });
      }
      res.json({ data: message });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const handlePrompt = async (req, res, isWireEnvelope) => {
    const body = req.body || {};
    const text = body.text || body.prompt || body.message;
    if (!text) return res.status(400).json({ error: 'Prompt text is required' });
    const promptId = promptIdSchema.safeParse(body.id);
    if (!promptId.success) {
      return res.status(400).json({ _tag: 'InvalidRequestError', message: 'id must be a message id such as msg_0123abc', field: 'id' });
    }
    const messageID = promptId.data ?? undefined;

    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const options = resolveTurnOptions(body, loaded.session, loaded.adapter);
      if (options.error) return res.status(400).json({ error: options.error });
      if (messageID && (await store.getMessages(loaded.session.id)).some((message) => message.id === messageID)) {
        return res.status(409).json({ _tag: 'ConflictError', message: `The session already has a message ${messageID}`, resource: messageID });
      }

      const { assistantMessageID } = await runtime.prompt({
        ...loaded,
        text,
        context: takeSynthetic(loaded.session.id),
        ...options,
        messageID,
      });
      if (isWireEnvelope) {
        res.json({ data: { id: assistantMessageID } });
      } else {
        res.json({ success: true, sessionId: loaded.session.id });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/api/sessions/:id/prompt', (req, res) => handlePrompt(req, res, false));
  app.post('/api/session/:id/prompt', (req, res) => handlePrompt(req, res, true));
  app.post('/api/session/:id/message', (req, res) => handlePrompt(req, res, true));
  app.post('/api/session/:id/command', (req, res) => {
    const cmd = req.body?.name || req.body?.command || '';
    const text = req.body?.text || '';
    req.body = { ...req.body, prompt: `${cmd} ${text}`.trim() };
    return handlePrompt(req, res, true);
  });

  // Permission replies
  const announceReplied = (sessionId, requestId) => {
    streamHub.broadcast(sessionId, {
      type: 'permission.replied',
      created: Date.now(),
      data: { sessionID: sessionId, requestID: requestId },
    });
  };

  const replyPermission = (sessionId, requestId, decision) => {
    const resolved = controlBridge.resolvePendingRequest(sessionId, requestId, decision);
    if (resolved) announceReplied(sessionId, requestId);
    return resolved;
  };

  const allowRestOfChat = (sessionId, requestId) => {
    const isPending = controlBridge.getPendingRequests(sessionId).some((item) => item.requestId === requestId);
    if (!isPending) return false;
    for (const answered of controlBridge.allowSession(sessionId)) announceReplied(sessionId, answered);
    return true;
  };

  app.post('/api/sessions/:id/permission', (req, res) => {
    const { requestId, decision } = req.body || {};
    if (!requestId || !['allow', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'requestId and decision ("allow"|"deny") are required' });
    }
    if (!replyPermission(req.params.id, requestId, decision)) {
      return res.status(404).json({ error: 'Pending permission request not found' });
    }
    res.json({ success: true });
  });

  // The UI sends OpenCode's replies: `once` allows this call, `always` every call
  // of the chat until it is deleted, `reject` denies this call.
  const WIRE_DECISIONS = { once: 'allow', always: 'allow', reject: 'deny' };
  app.post('/api/session/:id/permission/:requestID/reply', (req, res) => {
    const decision = WIRE_DECISIONS[req.body?.decision];
    if (!decision) {
      return res.status(400).json({ error: 'decision must be "once", "always" or "reject"' });
    }
    const replied = req.body.decision === 'always'
      ? allowRestOfChat(req.params.id, req.params.requestID)
      : replyPermission(req.params.id, req.params.requestID, decision);
    if (!replied) {
      return res.status(404).json({ error: 'Pending permission request not found' });
    }
    res.status(204).end();
  });

  const formNotFound = (res, formID) => res.status(404).json({ _tag: 'FormNotFoundError', formID, message: 'Form request not found' });
  app.post('/api/session/:id/form/:formID/reply', (req, res) => {
    const answer = formAnswerSchema.safeParse(req.body?.answer);
    if (!answer.success) {
      return res.status(400).json({ _tag: 'InvalidRequestError', message: 'answer must map each field key to its value', field: 'answer' });
    }
    if (!controlBridge.answerQuestion(req.params.id, req.params.formID, answer.data)) return formNotFound(res, req.params.formID);
    res.status(204).end();
  });
  app.delete('/api/session/:id/form/:formID', (req, res) => {
    if (!controlBridge.answerQuestion(req.params.id, req.params.formID, null)) return formNotFound(res, req.params.formID);
    res.status(204).end();
  });

  // Abort
  const handleAbort = async (req, res) => {
    const sessionId = req.params.id;
    const stopped = await runtime.abort(sessionId);
    // Nothing was running here, but the client asking to stop believes
    // something was: settle it the way a real stop would.
    if (!stopped) streamHub.broadcast(sessionId, executionEvent(sessionId, 'interrupted'));
    res.json({ success: true });
  };
  app.post('/api/sessions/:id/abort', handleAbort);
  app.post('/api/session/:id/abort', handleAbort);

  // Live events
  app.get('/api/sessions/:id/stream', (req, res) => {
    streamHub.subscribe(req.params.id, res);
  });
  app.get('/api/event', (req, res) => {
    streamHub.subscribe(req.query.sessionId || 'global', res);
  });
  app.get('/api/global/event', (req, res) => {
    streamHub.subscribe('global', res);
  });

  return { summary };
};

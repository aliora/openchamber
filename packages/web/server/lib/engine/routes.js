import express from 'express';
import { z } from 'zod';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode as readEnterpriseMode } from '../enterprise-mode.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { EngineSessionRuntime, executionEvent } from './session-runtime.js';
import { toPermissionRequest } from './permission-request.js';
import { createSessionSummary, streamSessionSummary } from './session-summary.js';
import { describeLocation, describeProjects, readVcs, requestDirectory } from './location.js';
import { historyQuerySchema, readHistoryPage, toWireHistory } from './wire-messages.js';
import { createEngineAvailability, defaultModelInfo, listModelInfos, toProviderInfo } from './catalog.js';

// HTTP routes for every registered engine. The singular `/api/session` family
// speaks the OpenCode 2.x wire shape the shared UI reads; the plural
// `/api/sessions` family returns stored records as they are.

const formatWireSession = (session, adapter) => {
  const cwd = session.cwd || process.cwd();
  return {
    ...session,
    engine: adapter.id,
    directory: cwd,
    location: { directory: cwd },
    projectID: session.projectID || 'default',
    agent: adapter.id,
    model: { providerID: adapter.providerID, id: session.model || adapter.defaultModel },
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
    packageManager: status.packageManager,
    packageManagerCommand: status.packageManagerCommand,
    canInstall: status.canInstall,
    installCommand: status.installCommand,
    state: status.state,
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

const startInstall = (adapter, res) => {
  const status = adapter.installer.getStatus();
  // A CLI that ships only through its own install script gives the command to run instead.
  if (!status.canInstall) {
    return res.status(400).json({
      error: `${adapter.displayName} cannot be installed from OpenChamber`,
      installCommand: status.installCommand,
    });
  }
  if (status.state === 'installing') {
    return res.json({ status: 'installing', message: 'Installation already in progress' });
  }
  adapter.installer.install().catch((err) => {
    console.error(`[engine:${adapter.id}] Background install error:`, err.message);
  });
  res.json({ status: 'installing', message: `${adapter.displayName} installation started` });
};

// An engine whose CLI cannot sign in or out from a server throws the step the user takes instead.
// An action that returns a promise, such as a sign-out that runs the CLI, is answered once it settles.
const runAuthAction = async (res, action, message) => {
  try {
    await action();
    res.json({ success: true, message });
  } catch (err) {
    res.status(501).json({ error: err.message });
  }
};

// The id the UI mints for a prompt (`ascendingId`); the user message keeps it,
// so the UI's optimistic copy of the prompt reconciles in place.
const promptIdSchema = z.string().regex(/^msg_[0-9A-Za-z]{1,64}$/).nullish();

/**
 * Resolves the prompt options against what the session's engine accepts.
 * Returns an error string for a value the engine does not know.
 */
const resolveTurnOptions = (body, session, adapter) => {
  const model = body.model?.id || body.model || session.model || adapter.defaultModel;
  const effort = body.effort || session.effort || adapter.defaultEffort;
  const permissionMode = body.permissionMode || session.permissionMode || adapter.defaultPermissionMode;

  if (!adapter.models.some((m) => m.id === model)) {
    return { error: `Unknown model for ${adapter.displayName}: ${String(model)}` };
  }
  if (effort && adapter.efforts && !adapter.efforts.includes(effort)) {
    return { error: `Unknown effort for ${adapter.displayName}: ${effort}` };
  }
  if (!adapter.permissionModes.includes(permissionMode)) {
    return { error: `Unknown permission mode for ${adapter.displayName}: ${permissionMode}` };
  }
  return { model, effort, permissionMode };
};

export const registerEngineRoutes = (app, { registry, ...dependencies }) => {
  const store = dependencies.store || new LocalSessionStore();
  const controlBridge = dependencies.controlBridge || new ControlBridge();
  const streamHub = dependencies.streamHub || new StreamHub();
  const isEnterpriseMode = dependencies.isEnterpriseMode || readEnterpriseMode;
  const availability = createEngineAvailability();
  // Optional: without it, engine processes run without OpenChamber's tools.
  const toolServer = dependencies.toolServer ?? null;
  const runtime = new EngineSessionRuntime({ store, streamHub, controlBridge, toolServer });
  // The managed Chats folders, so the session summary can mark chats.
  const summary = createSessionSummary({ store, registry, runtime, controlBridge, chatRoots: dependencies.chatRoots ?? [] });
  const defaultEngine = registry.getDefault();

  app.use('/api', (req, res, next) => {
    if (req.body !== undefined) return next();
    express.json({ limit: '50mb' })(req, res, next);
  });

  // Enterprise mode keeps conversations with the providers the administrator
  // set up, so signing in to one through this server is refused. Signing out
  // still works.
  const startLogin = (adapter, res) => {
    if (isEnterpriseMode()) {
      return res.status(403).json({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' });
    }
    return runAuthAction(res, () => adapter.auth.login(), 'Login flow started');
  };

  const withEngine = (handler) => (req, res) => {
    const adapter = registry.get(req.params.engine);
    if (!adapter) return res.status(404).json({ error: `Unknown engine: ${req.params.engine}` });
    return handler(adapter, req, res);
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
    return { session, adapter };
  };

  // Engines
  app.get('/api/engines', (req, res) => {
    res.json({ data: registry.list().map((adapter) => describeEngine(adapter)), default: defaultEngine.id });
  });
  app.get('/api/engines/:engine/status', withEngine((adapter, req, res) => {
    res.json(describeEngine(adapter, req.query.refresh === 'true'));
  }));
  app.post('/api/engines/:engine/install', withEngine((adapter, req, res) => startInstall(adapter, res)));
  app.get('/api/engines/:engine/install/stream', withEngine((adapter, req, res) => streamInstall(adapter, req, res)));
  app.get('/api/engines/:engine/auth/status', withEngine(async (adapter, req, res) => {
    res.json(await adapter.auth.status());
  }));
  app.post('/api/engines/:engine/auth/login', withEngine((adapter, req, res) => startLogin(adapter, res)));
  app.post('/api/engines/:engine/auth/logout', withEngine((adapter, req, res) => {
    runAuthAction(res, () => adapter.auth.logout(), 'Logged out');
  }));

  // Default-engine routes the current UI and desktop shell still call.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', engine: defaultEngine.id, engines: registry.list().map((a) => a.id) });
  });
  app.get('/api/engine/status', (req, res) => res.json(describeEngine(defaultEngine)));
  app.post('/api/engine/install', (req, res) => startInstall(defaultEngine, res));
  app.get('/api/engine/install/stream', (req, res) => streamInstall(defaultEngine, req, res));
  app.get('/api/codecli/compatibility', (req, res) => {
    const force = req.query.refresh === 'true' || req.query.force === 'true';
    res.json(describeCompatibility(defaultEngine.installer.getStatus(force)));
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
      info: { model: `${defaultEngine.providerID}/${defaultEngine.defaultModel}` },
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
      data: registry.list().map((adapter) => toProviderInfo(adapter, availability.isReady(adapter))),
    });
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
        model: { providerID: adapter.providerID, id: adapter.defaultModel },
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
  // Engines ask for permission but never for forms, and run no background shells.
  app.get('/api/form', (req, res) => {
    res.json({ location: { directory: directoryOf(req) }, data: [] });
  });
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
  const createSession = async (body, cwd) => {
    const adapter = body.engine ? registry.get(body.engine) : defaultEngine;
    if (!adapter) return { error: `Unknown engine: ${body.engine}` };
    const session = await store.createSession({
      ...body,
      cwd,
      engine: adapter.id,
      model: body.model?.id || body.model || adapter.defaultModel,
      effort: body.effort || adapter.defaultEffort,
      permissionMode: body.permissionMode || adapter.defaultPermissionMode,
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
    controlBridge.clearSession(sessionId);
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
      if (result.error) return res.status(400).json({ error: result.error });
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
      if (result.error) return res.status(400).json({ error: result.error });
      res.status(200).json({ data: formatWireSession(result.session, result.adapter) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Registered before `/api/sessions/:id`, which would read `summary` as a session id.
  app.get('/api/sessions/summary', async (req, res) => {
    try {
      res.json({ sessions: await summary.list() });
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
      res.json(session);
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
  const readSessionPatch = (body) => {
    const { engine: _engine, id: _id, engineState: _engineState, ...patch } = body || {};
    return patch;
  };

  app.patch('/api/sessions/:id', async (req, res) => {
    try {
      const session = await store.updateSession(req.params.id, readSessionPatch(req.body));
      summary.publish(req.params.id);
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/session/:id', async (req, res) => {
    try {
      await store.updateSession(req.params.id, readSessionPatch(req.body));
      summary.publish(req.params.id);
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
  app.post('/api/session/:id/synthetic', (req, res) => res.json({ success: true }));

  // The model picker lists every engine's models. Picking another engine's model moves a
  // chat that has no messages yet to that engine; a chat with history stays where it is,
  // because a CLI cannot continue another CLI's transcript.
  app.post('/api/session/:id/model', async (req, res) => {
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const requested = req.body?.model?.id || req.body?.model;
      const target = registry.forProvider(req.body?.model?.providerID) || loaded.adapter;
      if (!target.models.some((m) => m.id === requested)) {
        return res.status(400).json({ error: `Unknown model for ${target.displayName}: ${String(requested)}` });
      }
      const variant = req.body?.model?.variant;
      const effort = target.efforts?.includes(variant) ? variant : undefined;

      if (target.id === loaded.adapter.id) {
        const patch = { model: requested };
        if (effort) patch.effort = effort;
        await store.updateSession(req.params.id, patch);
        return res.status(204).end();
      }

      const history = await store.getMessages(req.params.id);
      if (history.length > 0 || runtime.isRunning(req.params.id)) {
        return res.status(409).json({
          error: `This chat runs on ${loaded.adapter.displayName}. Start a new chat to use ${target.displayName}.`,
        });
      }
      await store.updateSession(req.params.id, {
        engine: target.id,
        model: requested,
        effort: effort || target.defaultEffort,
        permissionMode: target.defaultPermissionMode,
        engineState: null,
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

      const { assistantMessageID } = await runtime.prompt({ ...loaded, text, ...options, messageID });
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
  const replyPermission = (sessionId, requestId, decision) => {
    const resolved = controlBridge.resolvePendingRequest(sessionId, requestId, decision);
    if (resolved) {
      streamHub.broadcast(sessionId, {
        type: 'permission.replied',
        created: Date.now(),
        data: { sessionID: sessionId, requestID: requestId },
      });
    }
    return resolved;
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

  // The UI sends OpenCode's replies: `once` and `always` allow this call, `reject` denies it.
  const WIRE_DECISIONS = { once: 'allow', always: 'allow', reject: 'deny' };
  app.post('/api/session/:id/permission/:requestID/reply', (req, res) => {
    const decision = WIRE_DECISIONS[req.body?.decision];
    if (!decision) {
      return res.status(400).json({ error: 'decision must be "once", "always" or "reject"' });
    }
    if (!replyPermission(req.params.id, req.params.requestID, decision)) {
      return res.status(404).json({ error: 'Pending permission request not found' });
    }
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
};

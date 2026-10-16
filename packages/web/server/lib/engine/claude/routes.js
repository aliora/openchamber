import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import express from 'express';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { ClaudeProcess } from './claude-process.js';
import { resolveClaudeExecutable } from './platform.js';
import { ClaudeInstaller } from './installer.js';

export const getSystemAuthStatus = async () => {
  try {
    const { command, isWindows } = resolveClaudeExecutable();
    const res = spawnSync(command, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      shell: isWindows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = (res.stdout || '').trim();
    if (!output) {
      return { loggedIn: false, reason: 'empty_response', stderr: res.stderr, status: res.status, error: res.error?.message };
    }
    const data = JSON.parse(output);
    return {
      loggedIn: Boolean(data.loggedIn),
      email: data.email || null,
      subscriptionType: data.subscriptionType || 'unknown',
      authMethod: data.authMethod || 'claude.ai',
    };
  } catch (err) {
    return { loggedIn: false, reason: err.message };
  }
};

export const formatWireSession = (s) => {
  if (!s) return s;
  const cwd = s.cwd || process.cwd();
  const modelId = typeof s.model === 'string' ? s.model : (s.model?.id || 'sonnet');
  return {
    ...s,
    directory: cwd,
    location: { directory: cwd },
    projectID: s.projectID || 'default',
    agent: s.agent || 'claude',
    model: { providerID: 'anthropic', id: modelId },
    time: { created: s.createdAt || Date.now(), updated: s.updatedAt || Date.now() },
    tokens: s.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: s.cost || 0,
  };
};

export const formatWireMessages = (messages, sessionId) => {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const parts = m.parts && m.parts.length > 0 ? m.parts.map((p, idx) => ({
      id: p.id || `${m.id}_p${idx}`,
      sessionID: sessionId,
      messageID: m.id,
      type: p.type || 'text',
      text: p.text || p.content || '',
      ...p,
    })) : [{
      id: `${m.id}_p0`,
      sessionID: sessionId,
      messageID: m.id,
      type: 'text',
      text: m.content || '',
    }];

    return {
      id: m.id,
      sessionID: sessionId,
      role: m.role || 'assistant',
      agent: m.agent || 'claude',
      providerID: 'anthropic',
      modelID: m.model || 'claude-3-7-sonnet-20250219',
      time: {
        created: m.createdAt || Date.now(),
        completed: m.completedAt || m.createdAt || Date.now(),
      },
      parts,
    };
  });
};

export const registerClaudeEngineRoutes = (app, dependencies = {}) => {
  const store = dependencies.store || new LocalSessionStore();
  const controlBridge = dependencies.controlBridge || new ControlBridge();
  const streamHub = dependencies.streamHub || new StreamHub();
  const installer = dependencies.installer || new ClaudeInstaller();
  const authStatusProvider = dependencies.authStatusProvider || getSystemAuthStatus;

  const activeProcesses = new Map();

  // Ensure JSON body parsing is active on /api
  app.use('/api', (req, res, next) => {
    if (req.body !== undefined) return next();
    express.json({ limit: '50mb' })(req, res, next);
  });

  // Engine health
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      engine: 'claude-code',
      version: '2.1.301',
    });
  });

  // Engine installer & status endpoints
  const handleEngineStatus = (req, res) => {
    const status = installer.getStatus();
    res.json({
      status: 'ok',
      engine: 'claude-code',
      installed: status.installed,
      version: status.version,
      rawVersion: status.rawVersion,
      command: status.command,
      packageManager: status.packageManager,
      packageManagerCommand: status.packageManagerCommand,
      canInstall: status.canInstall,
      state: status.state,
      lastError: status.lastError,
      detection: status.detection,
    });
  };

  app.get('/api/engine/status', handleEngineStatus);
  app.get('/api/claude/status', handleEngineStatus);

  const handleInstallTrigger = async (req, res) => {
    const currentStatus = installer.getStatus();
    if (currentStatus.state === 'installing') {
      return res.json({ status: 'installing', message: 'Installation already in progress' });
    }

    // Launch installation in background
    installer.install().catch((err) => {
      console.error('[ClaudeInstaller] Background install error:', err.message);
    });

    res.json({
      status: 'installing',
      message: 'Official Claude Code installation started',
      package: '@anthropic-ai/claude-code',
    });
  };

  app.post('/api/engine/install', handleInstallTrigger);
  app.post('/api/claude/install', handleInstallTrigger);

  // SSE Stream for live install output
  const handleInstallStream = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial status and existing logs
    sendEvent('status', installer.getStatus());
    for (const log of installer.getLogs()) {
      sendEvent('log', log);
    }

    const onLog = (logEntry) => {
      sendEvent('log', logEntry);
    };

    const onStatus = (statusEntry) => {
      sendEvent('status', statusEntry);
    };

    installer.on('log', onLog);
    installer.on('status', onStatus);

    req.on('close', () => {
      installer.off('log', onLog);
      installer.off('status', onStatus);
    });
  };

  app.get('/api/engine/install/stream', handleInstallStream);
  app.get('/api/claude/install/stream', handleInstallStream);

  // Code CLI compatibility endpoints for native UI gate
  const handleCompatibility = (req, res) => {
    const status = installer.getStatus();
    if (status.installed) {
      res.json({
        state: 'compatible',
        version: status.version || '2.1.301',
        installation: 'external',
        binary: status.command,
        minimumVersion: '2.0.0',
        canInstall: true,
      });
    } else {
      res.json({
        state: 'incompatible',
        version: null,
        installation: 'external',
        binary: null,
        minimumVersion: '2.0.0',
        canInstall: status.canInstall,
      });
    }
  };

  app.get('/api/codecli/compatibility', handleCompatibility);
  app.get('/api/opencode/compatibility', handleCompatibility);

  const handleInstallV2 = async (req, res) => {
    try {
      const result = await installer.install();
      res.json({ success: true, version: result.version });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Claude Code installation failed' });
    }
  };

  app.post('/api/codecli/install', handleInstallV2);
  app.post('/api/opencode/install-v2', handleInstallV2);

  app.post('/api/config/reload', (req, res) => {
    res.json({ success: true });
  });

  // OpenCode compatibility fallback probe
  app.get('/api/info', (req, res) => {
    res.json({
      version: '2.1.301',
      engine: 'claude-code',
      urls: {},
      paths: {},
    });
  });

  // Catalog routes for UI bootstrap
  app.get('/api/config', (req, res) => {
    res.json({
      data: [
        {
          type: 'document',
          source: 'claude-code',
          info: {
            model: 'sonnet',
            effort: 'medium',
          },
        },
      ],
    });
  });

  app.get('/api/provider', (req, res) => {
    res.json({
      data: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            {
              id: 'sonnet',
              name: 'Claude 3.7 Sonnet',
              providerID: 'anthropic',
              modelID: 'claude-3-7-sonnet-20250219',
            },
            {
              id: 'opus',
              name: 'Claude 3 Opus',
              providerID: 'anthropic',
              modelID: 'claude-3-opus-20240229',
            },
            {
              id: 'haiku',
              name: 'Claude 3.5 Haiku',
              providerID: 'anthropic',
              modelID: 'claude-3-5-haiku-20241022',
            },
          ],
        },
      ],
    });
  });

  app.get('/api/agent', (req, res) => {
    res.json({
      data: [
        {
          id: 'claude',
          name: 'Claude Code',
          description: 'Claude Code CLI autonomous agent',
          mode: 'primary',
          model: { providerID: 'anthropic', id: 'sonnet' },
        },
      ],
    });
  });

  app.get('/api/skill', (req, res) => {
    res.json({ data: [] });
  });

  app.get('/api/command', (req, res) => {
    res.json({ data: [] });
  });

  app.get('/api/permission/request', (req, res) => {
    res.json({ data: [] });
  });

  app.get('/api/permission/saved', (req, res) => {
    res.json({ data: [] });
  });

  app.get('/api/experimental/session/stats', (req, res) => {
    res.json({ data: {} });
  });

  app.get('/api/reference', (req, res) => {
    res.json({ data: [] });
  });

  // Auth routes
  app.get('/api/auth/status', async (req, res) => {
    try {
      const status = await authStatusProvider();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { command, isWindows } = resolveClaudeExecutable();
      spawnSync(command, ['auth', 'login', '--claudeai'], {
        detached: true,
        stdio: 'ignore',
        shell: isWindows,
        windowsHide: false,
      });
      res.json({ success: true, message: 'Login flow triggered in browser' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    try {
      const { command, isWindows } = resolveClaudeExecutable();
      spawnSync(command, ['auth', 'logout'], {
        encoding: 'utf8',
        timeout: 5000,
        shell: isWindows,
        windowsHide: true,
      });
      res.json({ success: true, message: 'Logged out' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sessions CRUD (plural /api/sessions for native tests, singular /api/session for UI client)
  app.get('/api/sessions', async (req, res) => {
    try {
      const cwd = req.query.directory || req.query.cwd || null;
      const sessions = await store.listSessions({ cwd });
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session', async (req, res) => {
    try {
      const cwd = req.query.directory || req.query.cwd || req.headers['x-opencode-directory'] || null;
      const sessions = await store.listSessions({ cwd });
      res.json({ data: sessions.map(formatWireSession) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/active', (req, res) => {
    const active = {};
    for (const [id, proc] of activeProcesses.entries()) {
      if (proc && !proc.isClosed) {
        active[id] = { type: 'running' };
      }
    }
    res.json({ data: active });
  });

  app.post('/api/session/:id/model', (req, res) => res.json({ success: true }));
  app.post('/api/session/:id/agent', (req, res) => res.json({ success: true }));
  app.post('/api/session/:id/synthetic', (req, res) => res.json({ success: true }));
  app.post('/api/session/:id/command', (req, res) => {
    const cmd = req.body?.name || req.body?.command || '';
    const text = req.body?.text || '';
    req.body = { ...req.body, prompt: `${cmd} ${text}`.trim() };
    return handlePrompt(req, res, true);
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const session = await store.createSession(req.body);
      streamHub.broadcast(session.id, {
        type: 'session.created',
        created: Date.now(),
        data: {
          sessionID: session.id,
          projectID: 'default',
          location: { directory: session.cwd },
          title: session.title,
        },
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session', async (req, res) => {
    try {
      const body = req.body || {};
      const dir = body.location?.directory || req.headers['x-opencode-directory'] || process.cwd();
      const session = await store.createSession({
        ...body,
        cwd: dir,
      });
      streamHub.broadcast(session.id, {
        type: 'session.created',
        created: Date.now(),
        data: {
          sessionID: session.id,
          projectID: 'default',
          location: { directory: session.cwd },
          title: session.title,
        },
      });
      res.status(200).json({ data: formatWireSession(session) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const session = await store.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const session = await store.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ data: formatWireSession(session) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/sessions/:id', async (req, res) => {
    try {
      const updated = await store.updateSession(req.params.id, req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/session/:id', async (req, res) => {
    try {
      await store.updateSession(req.params.id, req.body);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const sessionId = req.params.id;
      const proc = activeProcesses.get(sessionId);
      if (proc) {
        await proc.abort();
        activeProcesses.delete(sessionId);
      }
      streamHub.closeSession(sessionId);
      controlBridge.clearSession(sessionId);

      const deleted = await store.deleteSession(sessionId);
      if (!deleted) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/session/:id', async (req, res) => {
    try {
      const sessionId = req.params.id;
      const proc = activeProcesses.get(sessionId);
      if (proc) {
        await proc.abort();
        activeProcesses.delete(sessionId);
      }
      streamHub.closeSession(sessionId);
      controlBridge.clearSession(sessionId);

      await store.deleteSession(sessionId);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session/:id/agent', (req, res) => {
    res.status(204).end();
  });

  app.post('/api/session/:id/model', async (req, res) => {
    try {
      const modelId = req.body.model?.id || req.body.model || 'sonnet';
      await store.updateSession(req.params.id, { model: modelId });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Messages
  app.get('/api/sessions/:id/messages', async (req, res) => {
    try {
      const messages = await store.getMessages(req.params.id);
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id/message', async (req, res) => {
    try {
      const messages = await store.getMessages(req.params.id);
      res.json({ data: formatWireMessages(messages, req.params.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Prompt dispatch implementation helper
  const handlePrompt = async (req, res, isWireEnvelope = false) => {
    const sessionId = req.params.id;
    const body = req.body || {};
    const promptText = body.text || body.prompt || body.message;

    if (!promptText) {
      return res.status(400).json({ error: 'Prompt text is required' });
    }

    try {
      const session = await store.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const model = req.body.model || session.model || 'sonnet';
      const effort = req.body.effort || session.effort || 'medium';
      const permissionMode = req.body.permissionMode || session.permissionMode || 'auto';

      const assistantMessageID = `msg_${crypto.randomUUID()}`;
      const userMessageID = `msg_${crypto.randomUUID()}`;

      // Append user message to store
      await store.appendMessage(sessionId, {
        id: userMessageID,
        role: 'user',
        content: promptText,
        createdAt: Date.now(),
        parts: [{ id: `${userMessageID}_p0`, type: 'text', text: promptText }],
      });

      // Broadcast user message to UI stream
      streamHub.broadcast(sessionId, {
        type: 'session.inbox.enqueued',
        created: Date.now(),
        data: {
          sessionID: sessionId,
          inboxID: userMessageID,
          item: {
            type: 'user',
            payload: {
              text: promptText,
            },
          },
        },
      });

      streamHub.broadcast(sessionId, {
        type: 'session.execution.started',
        created: Date.now(),
        data: { sessionID: sessionId },
      });

      streamHub.broadcast(sessionId, {
        type: 'session.step.started',
        created: Date.now(),
        data: {
          assistantMessageID,
          sessionID: sessionId,
          agent: 'claude',
          model: { providerID: 'anthropic', id: typeof model === 'string' ? model : (model.id || 'sonnet') },
        },
      });

      let proc = activeProcesses.get(sessionId);
      if (!proc || !proc.isAlive) {
        proc = new ClaudeProcess({
          sessionId,
          cwd: session.cwd,
          model: typeof model === 'string' ? model : (model.id || 'sonnet'),
          effort,
          permissionMode,
          resume: true,
        });

        let accumulatedText = '';
        let accumulatedThinking = '';
        let textStarted = false;
        let reasoningStarted = false;

        proc.on('thinking_start', () => {
          reasoningStarted = true;
          streamHub.broadcast(sessionId, { type: 'thinking_start' });
          streamHub.broadcast(sessionId, {
            type: 'session.reasoning.started',
            created: Date.now(),
            data: { assistantMessageID, sessionID: sessionId, ordinal: 0 },
          });
        });

        proc.on('thinking_delta', (payload) => {
          if (!reasoningStarted) {
            reasoningStarted = true;
            streamHub.broadcast(sessionId, {
              type: 'session.reasoning.started',
              created: Date.now(),
              data: { assistantMessageID, sessionID: sessionId, ordinal: 0 },
            });
          }
          accumulatedThinking += payload.text;
          streamHub.broadcast(sessionId, { type: 'thinking_delta', text: payload.text });
          streamHub.broadcast(sessionId, {
            type: 'session.reasoning.delta',
            created: Date.now(),
            data: { assistantMessageID, sessionID: sessionId, ordinal: 0, delta: payload.text },
          });
        });

        proc.on('text_delta', (payload) => {
          if (reasoningStarted) {
            reasoningStarted = false;
            streamHub.broadcast(sessionId, {
              type: 'session.reasoning.ended',
              created: Date.now(),
              data: { assistantMessageID, sessionID: sessionId, ordinal: 0, text: accumulatedThinking },
            });
          }
          if (!textStarted) {
            textStarted = true;
            streamHub.broadcast(sessionId, {
              type: 'session.text.started',
              created: Date.now(),
              data: { assistantMessageID, sessionID: sessionId, ordinal: 0 },
            });
          }
          accumulatedText += payload.text;
          streamHub.broadcast(sessionId, { type: 'text_delta', text: payload.text });
          streamHub.broadcast(sessionId, {
            type: 'session.text.delta',
            created: Date.now(),
            data: { assistantMessageID, sessionID: sessionId, ordinal: 0, delta: payload.text },
          });
        });

        proc.on('tool_use_start', (payload) => {
          streamHub.broadcast(sessionId, {
            type: 'tool_use_start',
            id: payload.id,
            name: payload.name,
            input: payload.input,
          });
          streamHub.broadcast(sessionId, {
            type: 'session.tool.input.started',
            created: Date.now(),
            data: {
              id: payload.id,
              assistantMessageID,
              sessionID: sessionId,
              name: payload.name,
            },
          });
        });

        proc.on('tool_use_delta', (payload) => {
          streamHub.broadcast(sessionId, {
            type: 'tool_use_delta',
            index: payload.index,
            partialJson: payload.partialJson,
          });
        });

        proc.on('control_request', async (payload) => {
          streamHub.broadcast(sessionId, {
            type: 'permission_request',
            requestId: payload.requestId,
            toolName: payload.toolName,
            command: payload.command,
            input: payload.input,
          });
          streamHub.broadcast(sessionId, {
            type: 'permission.asked',
            created: Date.now(),
            data: {
              id: payload.requestId,
              sessionID: sessionId,
              tool: {
                name: payload.toolName || 'tool',
                input: payload.input || {},
              },
              message: payload.command || 'Approval requested for tool execution',
            },
          });

          const decision = await controlBridge.handleControlRequest(
            sessionId,
            payload,
            permissionMode
          );

          proc.sendControlResponse(payload.requestId, decision.behavior);
        });

        proc.on('assistant_message', async (msg) => {
          await store.appendMessage(sessionId, {
            id: assistantMessageID,
            role: 'assistant',
            content: msg.content?.map((c) => c.text || '').join('\n') || accumulatedText,
            createdAt: Date.now(),
            parts: [
              ...(accumulatedThinking ? [{
                id: `${assistantMessageID}_r0`,
                type: 'reasoning',
                text: accumulatedThinking,
              }] : []),
              {
                id: `${assistantMessageID}_t0`,
                type: 'text',
                text: accumulatedText || msg.content?.map((c) => c.text || '').join('\n') || '',
              },
            ],
          });
        });

        proc.on('result', (result) => {
          if (textStarted) {
            streamHub.broadcast(sessionId, {
              type: 'session.text.ended',
              created: Date.now(),
              data: { assistantMessageID, sessionID: sessionId, ordinal: 0, text: accumulatedText },
            });
          }
          streamHub.broadcast(sessionId, {
            type: 'session.step.ended',
            created: Date.now(),
            data: {
              assistantMessageID,
              sessionID: sessionId,
              finish: 'stop',
              cost: 0,
              tokens: result.usage ? {
                input: result.usage.input_tokens || 0,
                output: result.usage.output_tokens || 0,
                reasoning: result.usage.thinking_tokens || 0,
                cache: { read: 0, write: 0 },
              } : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          });
          streamHub.broadcast(sessionId, {
            type: 'session.idle',
            created: Date.now(),
            data: { sessionID: sessionId, outcome: 'succeeded' },
          });
          streamHub.broadcast(sessionId, {
            type: 'result',
            subtype: result.subtype,
            result: result.result,
            durationMs: result.durationMs,
            usage: result.usage,
          });
        });

        proc.on('exit', () => {
          activeProcesses.delete(sessionId);
          streamHub.broadcast(sessionId, { type: 'session_idle' });
        });

        await proc.start();
        activeProcesses.set(sessionId, proc);
      }

      // Send prompt to Claude
      proc.sendUserMessage(promptText);

      if (isWireEnvelope) {
        res.json({ data: { id: assistantMessageID } });
      } else {
        res.json({ success: true, sessionId });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/api/sessions/:id/prompt', (req, res) => handlePrompt(req, res, false));
  app.post('/api/session/:id/prompt', (req, res) => handlePrompt(req, res, true));
  app.post('/api/session/:id/message', (req, res) => handlePrompt(req, res, true));

  // Interactive permission response
  app.post('/api/sessions/:id/permission', (req, res) => {
    const sessionId = req.params.id;
    const { requestId, decision } = req.body;

    if (!requestId || !decision) {
      return res.status(400).json({ error: 'requestId and decision ("allow"|"deny") are required' });
    }

    const resolved = controlBridge.resolvePendingRequest(sessionId, requestId, decision);
    if (!resolved) {
      return res.status(404).json({ error: 'Pending permission request not found' });
    }

    streamHub.broadcast(sessionId, {
      type: 'permission.replied',
      created: Date.now(),
      data: { sessionID: sessionId, requestID: requestId },
    });

    res.json({ success: true });
  });

  app.post('/api/session/:id/permission/:requestID/reply', (req, res) => {
    const sessionId = req.params.id;
    const requestId = req.params.requestID;
    const decision = req.body?.decision || 'allow';

    const resolved = controlBridge.resolvePendingRequest(sessionId, requestId, decision);
    streamHub.broadcast(sessionId, {
      type: 'permission.replied',
      created: Date.now(),
      data: { sessionID: sessionId, requestID: requestId },
    });

    if (!resolved) {
      return res.status(404).json({ error: 'Pending permission request not found' });
    }
    res.status(204).end();
  });

  // Abort
  const handleAbort = async (req, res) => {
    const sessionId = req.params.id;
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      await proc.abort();
      activeProcesses.delete(sessionId);
    }
    streamHub.broadcast(sessionId, { type: 'session_aborted' });
    streamHub.broadcast(sessionId, {
      type: 'session.idle',
      created: Date.now(),
      data: { sessionID: sessionId, outcome: 'interrupted' },
    });
    res.json({ success: true });
  };

  app.post('/api/sessions/:id/abort', handleAbort);
  app.post('/api/session/:id/abort', handleAbort);

  // SSE Stream endpoints
  app.get('/api/sessions/:id/stream', (req, res) => {
    streamHub.subscribe(req.params.id, res);
  });

  app.get('/api/event', (req, res) => {
    const sessionId = req.query.sessionId || 'global';
    streamHub.subscribe(sessionId, res);
  });

  app.get('/api/global/event', (req, res) => {
    streamHub.subscribe('global', res);
  });
};

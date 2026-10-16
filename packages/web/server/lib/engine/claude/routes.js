import { spawnSync } from 'node:child_process';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { ClaudeProcess } from './claude-process.js';
import { resolveClaudeExecutable } from './platform.js';

export const getSystemAuthStatus = async () => {
  try {
    const { command, isWindows } = resolveClaudeExecutable();
    const res = spawnSync(command, ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      shell: isWindows,
      windowsHide: true,
    });

    const output = (res.stdout || '').trim();
    if (!output) {
      return { loggedIn: false, reason: 'empty_response' };
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

export const registerClaudeEngineRoutes = (app, dependencies = {}) => {
  const store = dependencies.store || new LocalSessionStore();
  const controlBridge = dependencies.controlBridge || new ControlBridge();
  const streamHub = dependencies.streamHub || new StreamHub();
  const authStatusProvider = dependencies.authStatusProvider || getSystemAuthStatus;

  const activeProcesses = new Map();

  // Engine health
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      engine: 'claude-code',
      version: '2.1.301',
    });
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

  // Sessions CRUD
  app.get('/api/sessions', async (req, res) => {
    try {
      const cwd = req.query.directory || req.query.cwd || null;
      const sessions = await store.listSessions({ cwd });
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const session = await store.createSession(req.body);
      res.status(201).json(session);
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

  app.patch('/api/sessions/:id', async (req, res) => {
    try {
      const updated = await store.updateSession(req.params.id, req.body);
      res.json(updated);
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

  // Messages
  app.get('/api/sessions/:id/messages', async (req, res) => {
    try {
      const messages = await store.getMessages(req.params.id);
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Prompt dispatch
  app.post('/api/sessions/:id/prompt', async (req, res) => {
    const sessionId = req.params.id;
    const promptText = req.body.text || req.body.prompt || req.body.message;

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

      let proc = activeProcesses.get(sessionId);
      if (!proc || !proc.isAlive) {
        proc = new ClaudeProcess({
          sessionId,
          cwd: session.cwd,
          model,
          effort,
          permissionMode,
          resume: true,
        });

        // Wire streaming events to StreamHub and Store
        let currentAssistantMessageId = null;

        proc.on('thinking_start', () => {
          streamHub.broadcast(sessionId, { type: 'thinking_start' });
        });

        proc.on('thinking_delta', (payload) => {
          streamHub.broadcast(sessionId, { type: 'thinking_delta', text: payload.text });
        });

        proc.on('text_delta', (payload) => {
          streamHub.broadcast(sessionId, { type: 'text_delta', text: payload.text });
        });

        proc.on('tool_use_start', (payload) => {
          streamHub.broadcast(sessionId, {
            type: 'tool_use_start',
            id: payload.id,
            name: payload.name,
            input: payload.input,
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

          const decision = await controlBridge.handleControlRequest(
            sessionId,
            payload,
            permissionMode
          );

          proc.sendControlResponse(payload.requestId, decision.behavior);
        });

        proc.on('assistant_message', async (msg) => {
          currentAssistantMessageId = msg.id;
          await store.appendMessage(sessionId, {
            id: msg.id,
            role: 'assistant',
            content: msg.content?.map((c) => c.text || '').join('\n') || '',
            createdAt: Date.now(),
            parts: msg.content || [],
          });
        });

        proc.on('result', (result) => {
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

      // Append user message to store
      await store.appendMessage(sessionId, {
        role: 'user',
        content: promptText,
        createdAt: Date.now(),
        parts: [{ type: 'text', content: promptText }],
      });

      // Send prompt to Claude
      proc.sendUserMessage(promptText);

      res.json({ success: true, sessionId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

    res.json({ success: true });
  });

  // Abort
  app.post('/api/sessions/:id/abort', async (req, res) => {
    const sessionId = req.params.id;
    const proc = activeProcesses.get(sessionId);
    if (proc) {
      await proc.abort();
      activeProcesses.delete(sessionId);
    }
    streamHub.broadcast(sessionId, { type: 'session_aborted' });
    res.json({ success: true });
  });

  // SSE Stream endpoint
  app.get('/api/sessions/:id/stream', (req, res) => {
    streamHub.subscribe(req.params.id, res);
  });

  // OpenCode event stream compatibility endpoint
  app.get('/api/event', (req, res) => {
    const sessionId = req.query.sessionId || 'global';
    streamHub.subscribe(sessionId, res);
  });
};

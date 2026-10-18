import { afterEach, describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { createAgentToolRuntime, describeToolResult } from './runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';

const temporaryDirectories = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async ({ settings = null, executeAction = mock(async () => ({ projects: [] })), getActivePort = () => 3901, getActiveHost } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-mcp-'));
  temporaryDirectories.push(dataDir);
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort,
    getActiveHost,
    executeAction,
    readSettings: async () => settings,
    isAgentMemoryAvailable: () => false,
  });
  const app = express();
  runtime.registerRoutes(app, express);
  return { runtime, app, executeAction, grant: runtime.engineToolServer.grant };
};

const rpc = (app, token, body) => request(app)
  .post('/api/openchamber/mcp')
  .set('authorization', `Bearer ${token}`)
  .send(body);

const callBody = (name, args, meta) => {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  return { jsonrpc: '2.0', id: 7, method: 'tools/call', params };
};

const envelopeOf = (response) => JSON.parse(response.body.result.content[0].text);

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});

const waitUntil = async (check) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return check();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return check();
};

describe('MCP endpoint protocol', () => {
  it('answers initialize in the version the client asked for, or its newest', async () => {
    const { app, grant } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const known = await rpc(app, server.token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } } }).expect(200);
    expect(known.body).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'openchamber', title: 'OpenChamber', version: '1.0.0' },
      },
    });
    const unknown = await rpc(app, server.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }).expect(200);
    expect(unknown.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('accepts notifications without an answer and refuses methods it does not serve', async () => {
    const { app, grant } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const notification = await rpc(app, server.token, { jsonrpc: '2.0', method: 'notifications/initialized' }).expect(202);
    expect(notification.text).toBe('');
    // Claude Code tries a newer discovery method first and falls back on this.
    const discover = await rpc(app, server.token, { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: {} }).expect(200);
    expect(discover.body).toEqual({ jsonrpc: '2.0', id: 'd1', error: { code: -32601, message: 'Method not found: server/discover' } });
    expect((await rpc(app, server.token, { jsonrpc: '2.0', id: 2, method: 'ping' })).body.result).toEqual({});
    expect((await rpc(app, server.token, { id: 3, method: 'tools/list' }).expect(400)).body.error.code).toBe(-32600);
  });

  it('opens no server stream and ends no session', async () => {
    const { app, grant } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    await request(app).get('/api/openchamber/mcp').set('authorization', `Bearer ${server.token}`).expect(405);
    await request(app).delete('/api/openchamber/mcp').set('authorization', `Bearer ${server.token}`).expect(405);
    await request(app).get('/api/openchamber/mcp').expect(401);
  });
});

describe('MCP endpoint tools', () => {
  it('writes standing instructions for the tools the settings turn on, and none when all are off', async () => {
    const on = await createRuntime();
    expect(await on.runtime.engineToolServer.instructions()).toContain('openchamber_web');

    const webOff = await createRuntime({ settings: { agentWebToolEnabled: false } });
    expect(await webOff.runtime.engineToolServer.instructions()).not.toContain('openchamber_web');

    const allOff = await createRuntime({ settings: { agentControlToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false } });
    expect(await allOff.runtime.engineToolServer.instructions()).toBeNull();
  });

  it('lists the tools the settings turn on, loaded up front unless Code Mode is on', async () => {
    const defaults = await createRuntime();
    const { server } = defaults.grant({ sessionId: 'ses_A', directory: '/repo' });
    const listed = (await rpc(defaults.app, server.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200)).body.result.tools;
    expect(listed.map((tool) => tool.name)).toEqual(['openchamber', 'openchamber_web', 'openchamber_knowledge', 'openchamber_render', 'openchamber_render_guide']);
    for (const tool of listed) {
      expect(tool._meta).toEqual({ 'anthropic/alwaysLoad': true });
      expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['action'], additionalProperties: true });
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const render = listed.find((tool) => tool.name === 'openchamber_render');
    expect(Object.keys(render.inputSchema.properties.parameters.properties).sort()).toEqual(['awaitAnswer', 'html', 'loading_messages', 'title', 'widget_code']);
    expect(render.inputSchema.properties.parameters.properties.loading_messages).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(render.description).toContain('openchamber_render_guide');
    const guide = listed.find((tool) => tool.name === 'openchamber_render_guide');
    expect(guide.inputSchema.properties.action.oneOf.map((entry) => entry.const)).toEqual(['render.guide']);
    expect(guide.inputSchema.properties.parameters.properties.modules.items.enum)
      .toEqual(['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation']);
    const web = listed.find((tool) => tool.name === 'openchamber_web');
    expect(web.inputSchema.properties.action.oneOf.map((entry) => entry.const)).toContain('browser.open');
    expect(Object.keys(web.inputSchema.properties.parameters.properties)).toContain('url');

    const toggled = await createRuntime({ settings: { agentWebToolEnabled: false, agentNotifyToolEnabled: true, agentRenderToolEnabled: false, agentToolsCodeMode: true } });
    const second = toggled.grant({ sessionId: 'ses_A', directory: '/repo' });
    const toggledTools = (await rpc(toggled.app, second.server.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools;
    expect(toggledTools.map((tool) => tool.name)).toEqual(['openchamber', 'openchamber_knowledge', 'openchamber_notify']);
    expect(toggledTools.every((tool) => tool._meta['anthropic/alwaysLoad'] === false)).toBe(true);
  });

  it('runs a call through the agent tool path as the session the token belongs to', async () => {
    const { app, grant, executeAction } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo/a' });

    const response = await rpc(app, server.token, callBody('openchamber', {
      action: 'projects.list',
      parameters: {},
      // Nothing a call carries names its session or its directory.
      sessionID: 'ses_foreign',
      contextSessionId: 'ses_foreign',
      contextDirectory: '/elsewhere',
    }, { 'claudecode/toolUseId': 'toolu_1' })).expect(200);

    expect(response.body.result.isError).toBe(false);
    expect(envelopeOf(response)).toEqual({ schemaVersion: 1, ok: true, action: 'projects.list', data: { projects: [] } });
    expect(executeAction).toHaveBeenCalledTimes(1);
    const [action, , directory, options] = executeAction.mock.calls[0];
    expect(action).toBe('projects.list');
    expect(directory).toBe('/repo/a');
    expect(options.contextSessionId).toBe('ses_A');
    expect(options.contextCallId).toBe('toolu_1');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('takes inputs beside the action or inside parameters, parameters winning', async () => {
    const { app, grant, executeAction } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    await rpc(app, server.token, callBody('openchamber', { action: 'file.open', path: 'beside.txt', parameters: { path: 'inside.txt' } }));
    await rpc(app, server.token, callBody('openchamber', { action: 'file.open', path: 'beside.txt' }));
    expect(executeAction.mock.calls.map(([, input]) => input.path)).toEqual(['inside.txt', 'beside.txt']);
  });

  it('keeps each token to its own session', async () => {
    const { app, grant, executeAction } = await createRuntime();
    const first = grant({ sessionId: 'ses_A', directory: '/repo/a' });
    const second = grant({ sessionId: 'ses_B', directory: '/repo/b' });
    expect(first.server.token).not.toBe(second.server.token);

    await rpc(app, second.server.token, callBody('openchamber', { action: 'projects.list' }));
    await rpc(app, first.server.token, callBody('openchamber', { action: 'projects.list' }));
    expect(executeAction.mock.calls.map(([, , directory, options]) => [options.contextSessionId, directory])).toEqual([
      ['ses_B', '/repo/b'],
      ['ses_A', '/repo/a'],
    ]);
  });

  it('refuses a tool the settings turned off, and one that does not exist, without running anything', async () => {
    const { app, grant, executeAction } = await createRuntime({ settings: { agentWebToolEnabled: false } });
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const off = await rpc(app, server.token, callBody('openchamber_web', { action: 'browser.open', url: 'https://example.com' })).expect(200);
    expect(off.body.error).toEqual({ code: -32602, message: 'openchamber_web is turned off in OpenChamber settings' });
    const unknown = await rpc(app, server.token, callBody('shell', { command: 'ls' })).expect(200);
    expect(unknown.body.error).toEqual({ code: -32602, message: 'Unknown tool: shell' });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('answers a refused action as a result carrying ok false, the way the plugin does', async () => {
    const { app, grant, executeAction } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    const response = await rpc(app, server.token, callBody('openchamber', { action: 'session.delete' })).expect(200);
    expect(response.body.result.isError).toBe(false);
    expect(envelopeOf(response)).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('MCP endpoint access', () => {
  it('refuses a missing or wrong token, a browser origin, and a caller from another machine', async () => {
    const { app, grant } = await createRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    await request(app).post('/api/openchamber/mcp').send(list).expect(401);
    await rpc(app, 'not-the-token', list).expect(401);
    await rpc(app, server.token, list).set('origin', 'http://localhost:3000').expect(403);

    const remote = express();
    remote.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.20', configurable: true });
      next();
    });
    const { runtime } = await createRuntime();
    runtime.registerRoutes(remote, express);
    const remoteGrant = runtime.engineToolServer.grant({ sessionId: 'ses_A', directory: '/repo' });
    await rpc(remote, remoteGrant.server.token, list).expect(401);
  });

  it('points the grant at the endpoint and keeps the token out of the URL', async () => {
    const { grant } = await createRuntime({ getActiveHost: () => '100.100.0.3' });
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    expect(server).toEqual({ name: 'openchamber', url: 'http://100.100.0.3:3901/api/openchamber/mcp', token: expect.stringMatching(/^[\w-]{43}$/) });
  });

  it('grants nothing while the listener has no port, or without a session', async () => {
    const { grant } = await createRuntime({ getActivePort: () => null });
    expect(() => grant({ sessionId: 'ses_A', directory: '/repo' })).toThrow('port is unavailable');
    const { grant: grantWithPort } = await createRuntime();
    expect(() => grantWithPort({ sessionId: '', directory: '/repo' })).toThrow('needs the session');
  });
});

describe('MCP grant lifecycle', () => {
  it('stops accepting a token once its process ended, and aborts the calls it still runs', async () => {
    let seenSignal = null;
    const executeAction = mock((_action, _input, _directory, { signal }) => new Promise((resolve, reject) => {
      seenSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const { app, grant } = await createRuntime({ executeAction });
    const { server, revoke } = grant({ sessionId: 'ses_A', directory: '/repo' });
    const base = await listen(app);

    const pending = fetch(`${base}/api/openchamber/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(callBody('openchamber', { action: 'projects.list' })),
    }).then((res) => res.json());
    await waitUntil(() => expect(seenSignal).not.toBeNull());

    revoke();
    const answer = await pending;
    expect(seenSignal.aborted).toBe(true);
    expect(JSON.parse(answer.result.content[0].text)).toMatchObject({ ok: false, error: { message: 'aborted' } });
    await rpc(app, server.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
    // Revoking twice is harmless.
    revoke();
  });
});

describe('MCP widgets', () => {
  const createWidgetRuntime = async () => {
    const service = createOpenChamberControlService({ sessionService: { resolveDirectory: async () => '/repo' } });
    return createRuntime({ executeAction: (...args) => service.execute(...args) });
  };

  it('draws widget_code sent flat, without an action, the way show_widget is called', async () => {
    const { app, grant } = await createWidgetRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const response = await rpc(app, server.token, callBody('openchamber_render', {
      widget_code: '<svg viewBox="0 0 100 40"><rect width="40" height="20"/></svg>',
      title: 'two_boxes',
      loading_messages: ['Placing boxes'],
    })).expect(200);

    const text = response.body.result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({ ok: true, action: 'render.page', data: { shown: true, title: 'two_boxes' } });
    expect(describeToolResult('openchamber_render', text)).toMatchObject({ openchamber: { ok: true, action: 'render.page' } });
  });

  it('still draws the older render.page call with html', async () => {
    const { app, grant } = await createWidgetRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const response = await rpc(app, server.token, callBody('openchamber_render', { action: 'render.page', parameters: { html: '<p>a</p>', title: 'Old' } })).expect(200);

    expect(envelopeOf(response)).toMatchObject({ ok: true, data: { shown: true, title: 'Old' } });
  });

  it('answers the guide for the modules asked for', async () => {
    const { app, grant } = await createWidgetRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const response = await rpc(app, server.token, callBody('openchamber_render_guide', { modules: ['chart'] })).expect(200);

    const envelope = envelopeOf(response);
    expect(envelope).toMatchObject({ ok: true, action: 'render.guide', data: { modules: ['chart'] } });
    expect(envelope.data.guide).toContain('--chart-1');
    expect(envelope.data.guide).toContain('Chart.js');
    expect(describeToolResult('openchamber_render_guide', JSON.stringify(envelope))).toMatchObject({ openchamber: { ok: true, action: 'render.guide' } });
  });

  it('drops the guide with the render tool', async () => {
    const { app, grant } = await createRuntime({ settings: { agentRenderToolEnabled: false } });
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const listed = (await rpc(app, server.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200)).body.result.tools;
    expect(listed.map((tool) => tool.name)).not.toContain('openchamber_render_guide');
  });
});

describe('MCP pages that wait for the user', () => {
  const createPageRuntime = async () => {
    const service = createOpenChamberControlService({ sessionService: { resolveDirectory: async () => '/repo' } });
    const runtime = await createRuntime({ executeAction: (...args) => service.execute(...args) });
    const base = await listen(runtime.app);
    return { ...runtime, service, base };
  };

  const askOnPage = (base, token, meta) => fetch(`${base}/api/openchamber/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(callBody('openchamber_render', { action: 'render.page', parameters: { html: '<p>Pick</p>', title: 'Pick a layout', awaitAnswer: true } }, meta)),
  }).then((res) => res.json()).then((body) => body.result.content[0].text);

  it('waits under the CLI\'s own call id, which is the id the chat answers by', async () => {
    const { grant, service, base } = await createPageRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const pending = askOnPage(base, server.token, { 'claudecode/toolUseId': 'toolu_page' });
    // Another session cannot answer this page.
    await waitUntil(() => expect(() => service.answerPage({ sessionId: 'ses_B', callId: 'toolu_page', summary: 'B' }))
      .toThrow(expect.objectContaining({ statusCode: 404 })));
    await waitUntil(() => service.answerPage({ sessionId: 'ses_A', callId: 'toolu_page', summary: 'Layout B', data: { layout: 'b' } }));
    const text = await pending;

    expect(JSON.parse(text)).toMatchObject({ ok: true, action: 'render.page', data: { answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } } });
    expect(describeToolResult('openchamber_render', text)).toEqual({
      openchamber: { schemaVersion: 1, action: 'render.page', description: expect.any(String), ok: true, answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } },
    });
  });

  it('ends the wait as answered in the chat when the user writes instead', async () => {
    const { grant, service, base } = await createPageRuntime();
    const { server, noteUserMessage } = grant({ sessionId: 'ses_A', directory: '/repo' });

    const pending = askOnPage(base, server.token, { 'claudecode/toolUseId': 'toolu_chat' });
    // Lets the call reach the server and start waiting there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    noteUserMessage();
    const text = await pending;

    expect(JSON.parse(text)).toMatchObject({ ok: true, data: { answer: { answered: false, reason: 'chat' }, note: expect.stringContaining('wrote in the chat') } });
    expect(describeToolResult('openchamber_render', text).openchamber.answer).toEqual({ answered: false, reason: 'chat' });
    expect(() => service.answerPage({ sessionId: 'ses_A', callId: 'toolu_chat', summary: 'late' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('refuses to wait for a CLI that sends no call id, so the agent asks in text', async () => {
    const { grant, base } = await createPageRuntime();
    const { server } = grant({ sessionId: 'ses_A', directory: '/repo' });
    expect(JSON.parse(await askOnPage(base, server.token))).toMatchObject({ ok: false, error: { kind: 'usage', message: expect.stringContaining('ask in text') } });
  });
});

describe('describeToolResult', () => {
  it('rebuilds the chat metadata only for OpenChamber envelopes', () => {
    expect(describeToolResult('openchamber_web', JSON.stringify({ schemaVersion: 1, ok: false, action: 'browser.open', error: { message: 'no' } })))
      .toEqual({ openchamber: { schemaVersion: 1, action: 'browser.open', description: 'Open a page in the browser panel', ok: false } });
    expect(describeToolResult('Bash', JSON.stringify({ schemaVersion: 1, ok: true, action: 'x' }))).toBeUndefined();
    expect(describeToolResult('openchamber_web', 'not json')).toBeUndefined();
    expect(describeToolResult('openchamber_web', JSON.stringify({ ok: true }))).toBeUndefined();
  });
});

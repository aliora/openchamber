import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { registerEngineRoutes } from './routes.js';
import { createEngineRegistry } from './registry.js';
import { LocalSessionStore } from './store.js';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';
import { createEngineAvailability } from './catalog.js';
import { createClaudeEngine } from './claude/adapter.js';
import { createAntigravityEngine } from './antigravity/adapter.js';
import { AntigravityInstaller } from './antigravity/installer.js';
import { createCodexEngine } from './codex/adapter.js';
import { createFakeEngine } from './test/fake-engine.js';

// The catalog routes as `@opencode/client` 2.0.29 reads them. The schemas
// restate the generated types (`ModelListOutput`, `ModelDefaultOutput`,
// `ProviderListOutput`, `McpListOutput` in
// node_modules/@opencode/client/dist/promise/generated/types.d.ts) as strict
// objects, so a field the client does not know fails too. The first route test
// records the answers in `test/catalog-responses.json`, which the UI's client
// test (packages/ui/src/lib/opencode/client.test.ts) feeds through the real
// client.

const locationSchema = z.strictObject({ directory: z.string() });
const headersSchema = z.record(z.string(), z.string());
const modelInfoSchema = z.strictObject({
  id: z.string(),
  modelID: z.string(),
  providerID: z.string(),
  canonical: z.string().optional(),
  family: z.string().optional(),
  name: z.string(),
  compatibility: z.json().optional(),
  package: z.string().optional(),
  settings: z.json().optional(),
  headers: headersSchema.optional(),
  body: z.json().optional(),
  capabilities: z.strictObject({ tools: z.boolean(), input: z.array(z.string()), output: z.array(z.string()) }),
  variants: z.array(z.strictObject({ id: z.string(), settings: z.json().optional(), headers: headersSchema.optional(), body: z.json().optional() })),
  time: z.strictObject({ released: z.number() }),
  cost: z.array(z.strictObject({
    tier: z.strictObject({ type: z.literal('context'), size: z.number() }).optional(),
    input: z.number(),
    output: z.number(),
    cache: z.strictObject({ read: z.number(), write: z.number() }),
  })),
  status: z.enum(['alpha', 'beta', 'deprecated', 'active']),
  enabled: z.boolean(),
  limit: z.strictObject({ context: z.number(), input: z.number().optional(), output: z.number() }),
});
const providerInfoSchema = z.strictObject({
  id: z.string(),
  canonical: z.string().optional(),
  integrationID: z.string().optional(),
  name: z.string(),
  activation: z.enum(['auto', 'enabled', 'disabled']),
  package: z.string(),
  compatibility: z.json().optional(),
  settings: z.json().optional(),
  headers: headersSchema.optional(),
  body: z.json().optional(),
});
const mcpServerSchema = z.strictObject({
  name: z.string(),
  status: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('connected') }),
    z.strictObject({ status: z.literal('pending') }),
    z.strictObject({ status: z.literal('disabled') }),
    z.strictObject({ status: z.literal('failed'), error: z.string() }),
    z.strictObject({ status: z.literal('needs_auth'), error: z.string() }),
  ]),
  integrationID: z.string().optional(),
});
const modelListOutputSchema = z.strictObject({ location: locationSchema, data: z.array(modelInfoSchema) });
const modelDefaultOutputSchema = z.strictObject({ location: locationSchema, data: modelInfoSchema.nullable() });
const providerListOutputSchema = z.strictObject({ location: locationSchema, data: z.array(providerInfoSchema) });
const mcpListOutputSchema = z.strictObject({ location: locationSchema, data: z.array(mcpServerSchema) });
const invalidRequestErrorSchema = z.strictObject({ _tag: z.literal('InvalidRequestError'), message: z.string().min(1) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const installerReporting = (installed) => new AntigravityInstaller({
  detect: () => ({ installed, version: installed ? '1.0.0' : null, command: installed ? '/bin/cli' : null }),
});

describe('engine availability', () => {
  const adapterWith = ({ installed = true, auth = async () => ({ loggedIn: true }) } = {}) => {
    const calls = { status: 0, auth: 0 };
    const adapter = createFakeEngine({ id: 'probe' });
    adapter.installer.getStatus = () => {
      calls.status += 1;
      return { installed };
    };
    adapter.auth.status = () => {
      calls.auth += 1;
      return auth();
    };
    return { adapter, calls };
  };

  it('answers before the CLI is asked, then the checked state', async () => {
    const { adapter, calls } = adapterWith();
    const availability = createEngineAvailability();

    expect(availability.isReady(adapter)).toBe(false);
    // The check waits until the request has been answered.
    expect(calls).toEqual({ status: 0, auth: 0 });
    await settle();
    expect(calls).toEqual({ status: 1, auth: 1 });
    expect(availability.isReady(adapter)).toBe(true);
    expect(calls).toEqual({ status: 1, auth: 1 });
  });

  it('does not ask a missing CLI about its sign-in, and treats a failed check as not ready', async () => {
    const missing = adapterWith({ installed: false });
    const failing = adapterWith({ auth: async () => { throw new Error('auth status crashed'); } });
    const signedOut = adapterWith({ auth: async () => ({ loggedIn: false }) });
    const availability = createEngineAvailability();

    for (const { adapter } of [missing, failing, signedOut]) availability.isReady(adapter);
    await settle();

    expect(missing.calls).toEqual({ status: 1, auth: 0 });
    expect(availability.isReady(missing.adapter)).toBe(false);
    expect(availability.isReady(failing.adapter)).toBe(false);
    expect(availability.isReady(signedOut.adapter)).toBe(false);
  });

  it('checks once at a time and again after the TTL', async () => {
    let clock = 1_000;
    const { adapter, calls } = adapterWith();
    const availability = createEngineAvailability({ ttlMs: 500, now: () => clock });

    availability.isReady(adapter);
    availability.isReady(adapter);
    await settle();
    expect(calls.auth).toBe(1);

    clock += 499;
    expect(availability.isReady(adapter)).toBe(true);
    await settle();
    expect(calls.auth).toBe(1);

    clock += 1;
    // A stale state is still answered while the new check runs.
    expect(availability.isReady(adapter)).toBe(true);
    await settle();
    expect(calls.auth).toBe(2);
  });
});

describe('engine catalog routes', () => {
  let server;
  let baseUrl;
  let tmpDir;

  const start = ({ toolServer } = {}) => {
    // Claude installed and signed in, Antigravity not installed, Codex installed and signed out.
    const registry = createEngineRegistry([
      createClaudeEngine({ installer: installerReporting(true), authStatusProvider: async () => ({ loggedIn: true }) }),
      createAntigravityEngine({ installer: installerReporting(false), authStatusProvider: async () => ({ loggedIn: true }), platform: 'linux' }),
      createCodexEngine({ installer: installerReporting(true), authStatusProvider: async () => ({ loggedIn: false }) }),
    ]);
    const app = express();
    app.use(express.json());
    registerEngineRoutes(app, {
      registry,
      store: new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') }),
      controlBridge: new ControlBridge(),
      streamHub: new StreamHub(),
      toolServer,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  };

  beforeEach(() => {
    server = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-catalog-test-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The client scopes these reads with the percent-encoded directory header.
  const read = async (url, { method = 'GET' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'x-opencode-directory': encodeURIComponent('/work/repo') } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const toolServer = {
    name: 'openchamber',
    grant: () => ({ server: { name: 'openchamber', url: 'http://127.0.0.1:1/mcp', token: 't' }, revoke: () => {}, noteUserMessage: () => {} }),
    describeResult: () => undefined,
  };

  it('serves every engine model, the default model, one provider per engine and the tool server', async () => {
    start({ toolServer });
    // The first read starts the CLI checks and answers before they finish.
    const cold = providerListOutputSchema.parse((await read('/api/provider')).body);
    expect(cold.data.map((provider) => provider.activation)).toEqual(['auto', 'auto', 'auto']);
    await settle();

    const model = await read('/api/model');
    const modelDefault = await read('/api/model/default');
    const provider = await read('/api/provider');
    const mcp = await read('/api/mcp');
    const mcpDisconnect = await read('/api/experimental/mcp/openchamber/disconnect', { method: 'POST' });
    for (const answer of [model, modelDefault, provider, mcp]) expect(answer.status).toBe(200);

    const models = modelListOutputSchema.parse(model.body);
    expect(models.location).toEqual({ directory: '/work/repo' });
    const idsOf = (providerID) => models.data.filter((entry) => entry.providerID === providerID).map((entry) => entry.id);
    expect(idsOf('anthropic')).toEqual(['sonnet', 'opus', 'haiku']);
    expect(idsOf('google')).toEqual(['default', 'gemini-3.8-flash']);
    expect(idsOf('openai')).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
    for (const entry of models.data) {
      expect(entry.modelID).toBe(entry.id);
      expect(entry.enabled).toBe(true);
      expect(entry.status).toBe('active');
      expect(entry.cost).toEqual([]);
      // A prompt reaches every CLI as text, so no model claims attachments.
      expect(entry.capabilities).toEqual({ tools: true, input: ['text'], output: ['text'] });
    }
    // The variants are the efforts the session model route accepts.
    const variantsOf = (providerID, id) => models.data
      .find((entry) => entry.providerID === providerID && entry.id === id).variants.map((variant) => variant.id);
    expect(variantsOf('anthropic', 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(variantsOf('openai', 'gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(variantsOf('google', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(variantsOf('google', 'default')).toEqual([]);
    // Sizes the CLI states, and the conservative ones where it states none.
    const limitOf = (id) => models.data.find((entry) => entry.id === id).limit;
    expect(models.data.find((entry) => entry.id === 'sonnet').family).toBe('claude-sonnet');
    expect(limitOf('sonnet')).toEqual({ context: 1_000_000, output: 128_000 });
    expect(limitOf('gpt-5.5')).toEqual({ context: 272_000, output: 32_000 });
    expect(limitOf('gemini-3.8-flash')).toEqual({ context: 200_000, output: 32_000 });

    expect(modelDefaultOutputSchema.parse(modelDefault.body).data).toMatchObject({ id: 'sonnet', providerID: 'anthropic' });

    // Ready only when the CLI is installed and signed in; never `disabled`, which hides a provider.
    expect(providerListOutputSchema.parse(provider.body).data).toEqual([
      { id: 'anthropic', name: 'Claude Code', activation: 'enabled', package: 'openchamber/engine/claude' },
      { id: 'google', name: 'Antigravity', activation: 'auto', package: 'openchamber/engine/antigravity' },
      { id: 'openai', name: 'Codex', activation: 'auto', package: 'openchamber/engine/codex' },
    ]);

    expect(mcpListOutputSchema.parse(mcp.body).data).toEqual([{ name: 'openchamber', status: { status: 'connected' } }]);
    expect(mcpDisconnect.status).toBe(400);
    invalidRequestErrorSchema.parse(mcpDisconnect.body);

    const recorded = {
      model: model.body,
      modelDefault: modelDefault.body,
      provider: provider.body,
      mcp: mcp.body,
      mcpDisconnect: mcpDisconnect.body,
    };
    await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot('./test/catalog-responses.json');
  });

  it('answers MCP changes with an error the UI shows, and connecting the tool server as done', async () => {
    start({ toolServer });
    expect((await read('/api/experimental/mcp/openchamber/connect', { method: 'POST' })).status).toBe(204);

    const changes = [
      ['POST', '/api/experimental/mcp/github/connect'],
      ['POST', '/api/experimental/mcp/github/disconnect'],
      ['PUT', '/api/experimental/mcp/github'],
      ['DELETE', '/api/experimental/mcp/github'],
      ['DELETE', '/api/experimental/mcp/openchamber'],
    ];
    for (const [method, url] of changes) {
      const answer = await read(url, { method });
      expect(answer.status).toBe(400);
      expect(invalidRequestErrorSchema.parse(answer.body).message).toMatch(/OpenChamber/);
    }
    const otherServer = await read('/api/experimental/mcp/github/connect', { method: 'POST' });
    expect(otherServer.body.message).toContain('Each CLI loads the MCP servers in its own configuration');
  });

  it('lists no MCP server when the tool server is not wired', async () => {
    start();
    const mcp = mcpListOutputSchema.parse((await read('/api/mcp')).body);
    expect(mcp).toEqual({ location: { directory: '/work/repo' }, data: [] });
    expect((await read('/api/experimental/mcp/openchamber/connect', { method: 'POST' })).status).toBe(400);
  });
});

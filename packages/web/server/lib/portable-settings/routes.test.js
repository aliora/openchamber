import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerPortableSettingsRoutes } from './routes.js';

const createApp = (catalog) => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  registerPortableSettingsRoutes(app, { getCatalog: async () => catalog });
  return app;
};

const catalogStub = () => ({
  snapshot: vi.fn(async () => ({ version: 1, categories: { mcp: { status: 'ok', items: [] } } })),
  exportItems: vi.fn(async (refs) => refs.map((ref) => ({ ...ref, status: 'missing' }))),
  importItems: vi.fn(async ({ items }) => items.map(({ category, key }) => ({ category, key, status: 'applied' }))),
});

describe('portable settings routes', () => {
  it('answers the snapshot uncached', async () => {
    const response = await request(createApp(catalogStub())).get('/api/portable-settings');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.categories.mcp.status).toBe('ok');
  });

  it.each([
    [{}],
    [{ items: [] }],
    [{ items: [{ category: 'themes', key: 'x' }] }],
    [{ items: [{ category: 'mcp', key: '' }] }],
  ])('refuses a malformed export request %j', async (body) => {
    const catalog = catalogStub();
    const response = await request(createApp(catalog)).post('/api/portable-settings/export').send(body);
    expect(response.status).toBe(400);
    expect(catalog.exportItems).not.toHaveBeenCalled();
  });

  it.each([
    [{ items: [{ category: 'mcp', key: 'github' }] }],
    [{ items: [{ category: 'mcp', key: 'github', value: {}, updatedAt: -1 }] }],
    [{ removals: 'all' }],
    [{ force: 'yes' }],
  ])('refuses a malformed import %j', async (body) => {
    const catalog = catalogStub();
    const response = await request(createApp(catalog)).put('/api/portable-settings').send(body);
    expect(response.status).toBe(400);
    expect(catalog.importItems).not.toHaveBeenCalled();
  });

  it('passes a valid import through with only the known fields', async () => {
    const catalog = catalogStub();
    const response = await request(createApp(catalog)).put('/api/portable-settings').send({
      items: [{ category: 'mcp', key: 'github', value: { type: 'remote' }, updatedAt: 5, extra: true }],
      force: true,
    });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([{ category: 'mcp', key: 'github', status: 'applied' }]);
    expect(catalog.importItems).toHaveBeenCalledWith({
      items: [{ category: 'mcp', key: 'github', value: { type: 'remote' }, updatedAt: 5 }],
      removals: [],
      force: true,
    });
  });

  it('does not log a value when the write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const catalog = { ...catalogStub(), importItems: vi.fn(async () => { throw new Error('boom'); }) };
    const response = await request(createApp(catalog)).put('/api/portable-settings').send({
      items: [{ category: 'mcp', key: 'github', value: { headers: { Authorization: 'Bearer secret-token' } } }],
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
    error.mockRestore();
  });
});

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenChamberRoutes } from './openchamber-routes.js';

const createApp = () => {
  const app = express();
  registerOpenChamberRoutes(app, {
    modelsDevApiUrl: 'https://models.example.test',
    modelsMetadataCacheTtl: 0,
    fetchFreeZenModels: vi.fn(),
    getCachedZenModels: vi.fn(),
  });
  return app;
};

describe('OpenChamber update routes', () => {
  it('always reports that no update is available', async () => {
    const response = await request(createApp()).get('/api/openchamber/update-check?appType=web').expect(200);

    expect(response.body).toEqual({ available: false });
  });

  it('has no route that installs an update', async () => {
    await request(createApp()).post('/api/openchamber/update-install').expect(404);
  });
});

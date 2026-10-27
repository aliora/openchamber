import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createApp = (getIsShuttingDown) => {
  const app = express();
  registerOpenCodeRoutes(app, {
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getIsShuttingDown,
  });
  return app;
};

describe('OpenCode health route', () => {
  it('reports a server that is shutting down as unhealthy although OpenCode still answers', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ version: '2.1.0' }));
    let shuttingDown = false;
    const app = createApp(() => shuttingDown);

    await request(app).get('/api/opencode/health').expect(200, { healthy: true });

    shuttingDown = true;
    await request(app).get('/api/opencode/health?wait=5000').expect(503, { healthy: false, shuttingDown: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

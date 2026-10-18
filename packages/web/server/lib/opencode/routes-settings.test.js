import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const createApp = () => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    formatSettingsResponse: (settings) => settings,
    readSettingsFromDiskMigrated: vi.fn(async () => ({ fontSize: 120 })),
    readProfileUpdatedAt: vi.fn(async () => ({ fontSize: 5000 })),
    persistSettings: vi.fn(async (changes) => ({ ...changes, _profileUpdatedAt: { fontSize: 6000 }, _profileIgnored: [] })),
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('settings routes: profile timestamps', () => {
  it('leaves the GET response unchanged without profileMeta', async () => {
    const { app, dependencies } = createApp();
    const response = await request(app).get('/api/config/settings?surface=mobile').expect(200);
    expect(response.body).toEqual({ fontSize: 120 });
    expect(dependencies.readProfileUpdatedAt).not.toHaveBeenCalled();
  });

  it('adds the resolved profile timestamps to GET with profileMeta=1', async () => {
    const { app, dependencies } = createApp();
    const response = await request(app).get('/api/config/settings?surface=mobile&profileMeta=1').expect(200);
    expect(response.body).toEqual({ fontSize: 120, _profileUpdatedAt: { fontSize: 5000 } });
    expect(dependencies.readProfileUpdatedAt).toHaveBeenCalledWith({ surface: 'mobile' });
  });

  it('passes client timestamps through PUT and returns the persisted meta', async () => {
    const { app, dependencies } = createApp();
    const body = { fontSize: 130, _profileUpdatedAt: { fontSize: 6000 } };
    const response = await request(app).put('/api/config/settings?surface=mobile').send(body).expect(200);
    expect(dependencies.persistSettings).toHaveBeenCalledWith(body, { surface: 'mobile' });
    expect(response.body).toEqual({ fontSize: 130, _profileUpdatedAt: { fontSize: 6000 }, _profileIgnored: [] });
  });
});

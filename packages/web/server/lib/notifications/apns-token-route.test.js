import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerNotificationRoutes } from './routes.js';

const createApp = () => {
  const addOrUpdateApnsToken = vi.fn(async () => {});
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app, {
    getUiSessionTokenFromRequest: () => 'ui-session',
    addOrUpdateApnsToken,
  });
  return { app, addOrUpdateApnsToken };
};

describe('POST /api/push/apns-token', () => {
  it('stores the id the phone gave this server with its token', async () => {
    const { app, addOrUpdateApnsToken } = createApp();

    const response = await request(app)
      .post('/api/push/apns-token')
      .set('User-Agent', 'OpenChamber-iOS')
      .send({ token: 'device-token', platform: 'ios', environment: 'sandbox', clientConnectionId: 'conn-pi' });

    expect(response.status).toBe(200);
    expect(addOrUpdateApnsToken).toHaveBeenCalledWith('ui-session', 'device-token', 'OpenChamber-iOS', 'ios', 'sandbox', undefined, 'conn-pi');
  });

  it('accepts a phone that sends no id', async () => {
    const { app, addOrUpdateApnsToken } = createApp();

    await request(app).post('/api/push/apns-token').send({ token: 'device-token' });

    expect(addOrUpdateApnsToken.mock.calls[0][6]).toBeUndefined();
  });
});

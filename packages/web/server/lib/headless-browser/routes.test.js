import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { HeadlessBrowserError } from './manager.js';
import { registerHeadlessBrowserRoutes } from './routes.js';

const fakeTab = () => {
  const tab = {
    calls: [],
    listener: null,
    unsubscribed: false,
    subscriberCount: 0,
    async navigate(url, options) { tab.calls.push(['navigate', url, options]); return { url, title: 'T', settled: true }; },
    async evaluate(script) { tab.calls.push(['evaluate', script]); return { ok: true }; },
    async settle() { return true; },
    async capture() { return { base64: 'AA', mime: 'image/png', width: 1, height: 1, url: 'u', title: 't' }; },
    async history(delta) { tab.calls.push(['history', delta]); return { url: 'h', title: '' }; },
    async reload() { tab.calls.push(['reload']); },
    async setViewport(next) { tab.calls.push(['viewport', next]); return { mode: 'custom', width: 1, height: 1 }; },
    async fit(width, height) { tab.calls.push(['fit', width, height]); },
    viewportSummary: () => ({ mode: 'fill', width: 1, height: 1 }),
    info: () => ({ url: 'u', title: 't', loading: false }),
    consoleProblems: () => [],
    async click(x, y) { tab.calls.push(['click', x, y]); },
    async typeText(text, options) { tab.calls.push(['type', text, options]); },
    async input(event) { tab.calls.push(['input', event]); if (event.kind === 'bad') throw new Error('Unsupported input event'); },
    async subscribe(listener) {
      tab.listener = listener;
      listener({ type: 'meta', url: 'u', title: 't', loading: false });
      return async () => { tab.unsubscribed = true; };
    },
  };
  return tab;
};

const setup = ({ available = true } = {}) => {
  const tab = fakeTab();
  const closed = [];
  const manager = {
    status: () => (available ? { available: true, source: 'system', tabs: 0, running: false } : { available: false, reason: 'No Chrome', tabs: 0, running: false }),
    tab: async (id) => {
      if (id === 'hb-full') throw new HeadlessBrowserError('too many tabs', 409);
      return tab;
    },
    existingTab: (id) => (id === 'hb-1' ? tab : null),
    closeTab: async (id) => { closed.push(id); return true; },
  };
  const app = express();
  registerHeadlessBrowserRoutes(app, { express, manager });
  return { app, tab, closed };
};

describe('headless browser routes', () => {
  it('reports whether the server can run a browser', async () => {
    expect((await request(setup().app).get('/api/headless-browser/status')).body).toMatchObject({ available: true });
    expect((await request(setup({ available: false }).app).get('/api/headless-browser/status')).body).toMatchObject({ available: false, reason: 'No Chrome' });
  });

  it('runs navigate, evaluate, history and viewport commands on the tab', async () => {
    const { app, tab } = setup();
    const send = (body) => request(app).post('/api/headless-browser/tabs/hb-1/command').send(body);
    expect((await send({ command: 'navigate', url: 'https://a.test/' })).body).toEqual({ url: 'https://a.test/', title: 'T', settled: true });
    expect((await send({ command: 'evaluate', script: '1+1' })).body).toEqual({ value: { ok: true } });
    expect((await send({ command: 'history', direction: 'forward' })).status).toBe(200);
    expect((await send({ command: 'viewport', fill: false, width: 390, height: 844 })).status).toBe(200);
    expect(tab.calls).toContainEqual(['history', 1]);
    expect(tab.calls).toContainEqual(['viewport', { kind: 'fixed', width: 390, height: 844 }]);
  });

  it('clicks at a point and types with real input', async () => {
    const { app, tab } = setup();
    const send = (body) => request(app).post('/api/headless-browser/tabs/hb-1/command').send(body);
    expect((await send({ command: 'click', x: 3, y: 4 })).status).toBe(200);
    expect((await send({ command: 'type', text: 'hello', submit: true })).status).toBe(200);
    expect((await send({ command: 'click', x: 'a', y: 4 })).status).toBe(400);
    expect((await send({ command: 'type' })).status).toBe(400);
    expect(tab.calls).toContainEqual(['click', 3, 4]);
    expect(tab.calls).toContainEqual(['type', 'hello', { submit: true }]);
  });

  it('answers info with problems and the layout', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/headless-browser/tabs/hb-1/command').send({ command: 'info' });
    expect(response.body).toEqual({ url: 'u', title: 't', loading: false, problems: [], viewport: { mode: 'fill', width: 1, height: 1 } });
  });

  it('rejects incomplete and unknown commands', async () => {
    const { app } = setup();
    const send = (body) => request(app).post('/api/headless-browser/tabs/hb-1/command').send(body);
    expect((await send({ command: 'navigate' })).status).toBe(400);
    expect((await send({ command: 'evaluate' })).status).toBe(400);
    expect((await send({ command: 'selfdestruct' })).status).toBe(400);
  });

  it('refuses a tab id that is not safe', async () => {
    const response = await request(setup().app).post('/api/headless-browser/tabs/a%20b/command').send({ command: 'info' });
    expect(response.status).toBe(400);
  });

  it('passes the manager error status through', async () => {
    const response = await request(setup().app).post('/api/headless-browser/tabs/hb-full/command').send({ command: 'info' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('too many tabs');
  });

  it('forwards pointer and key input to an open tab only', async () => {
    const { app, tab } = setup();
    expect((await request(app).post('/api/headless-browser/tabs/hb-1/input').send({ kind: 'mouse', type: 'down', x: 1, y: 2 })).status).toBe(200);
    expect(tab.calls).toContainEqual(['input', { kind: 'mouse', type: 'down', x: 1, y: 2 }]);
    expect((await request(app).post('/api/headless-browser/tabs/hb-2/input').send({ kind: 'mouse' })).status).toBe(404);
    expect((await request(app).post('/api/headless-browser/tabs/hb-1/input').send({ kind: 'bad' })).status).toBe(500);
  });

  it('closes a tab on delete', async () => {
    const { app, closed } = setup();
    expect((await request(app).delete('/api/headless-browser/tabs/hb-1')).body).toEqual({ closed: true });
    expect(closed).toEqual(['hb-1']);
  });

  it('streams frames as server-sent events and releases the viewer on disconnect', async () => {
    const { app, tab } = setup();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const chunks = [];
    const clientRequest = http.get({ port, host: '127.0.0.1', path: '/api/headless-browser/tabs/hb-1/stream' });
    const response = await new Promise((resolve) => clientRequest.on('response', resolve));
    expect(response.headers['content-type']).toBe('text/event-stream');
    response.on('data', (chunk) => chunks.push(String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    tab.listener({ type: 'frame', data: 'JPEG', width: 2, height: 3 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    clientRequest.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const text = chunks.join('');
    expect(text).toContain('data: {"type":"meta"');
    expect(text).toContain('data: {"type":"frame","data":"JPEG","width":2,"height":3}');
    expect(tab.unsubscribed).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectCdp } from './cdp-client.js';

const servers = [];

const startServer = (onMessage) => new Promise((resolve) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
    server.on('connection', (socket) => socket.on('message', (raw) => onMessage(JSON.parse(String(raw)), socket)));
    servers.push(server);
    resolve({ server, url: `ws://127.0.0.1:${server.address().port}` });
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(resolve);
  })));
});

describe('connectCdp', () => {
  it('matches answers to calls by id and sends the session', async () => {
    const seen = [];
    const { url } = await startServer((message, socket) => {
      seen.push(message);
      socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
    });
    const connection = await connectCdp(url);
    expect(await connection.send('Page.enable', {}, 'session-1')).toEqual({ echoed: 'Page.enable' });
    expect(seen[0]).toMatchObject({ method: 'Page.enable', sessionId: 'session-1' });
    connection.close();
  });

  it('rejects a call the browser refuses with its message', async () => {
    const { url } = await startServer((message, socket) => socket.send(JSON.stringify({ id: message.id, error: { message: 'no such target' } })));
    const connection = await connectCdp(url);
    await expect(connection.send('Target.attachToTarget')).rejects.toThrow('no such target');
    connection.close();
  });

  it('delivers events to listeners together with their session', async () => {
    const { url } = await startServer((message, socket) => {
      socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's9' }));
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
    const connection = await connectCdp(url);
    const events = [];
    connection.on('Page.loadEventFired', (params, session) => events.push([params, session]));
    await connection.send('Page.enable');
    expect(events).toEqual([[{ timestamp: 1 }, 's9']]);
    connection.close();
  });

  it('fails calls in flight when the browser goes away', async () => {
    const { url } = await startServer((message, socket) => socket.close());
    const connection = await connectCdp(url);
    await expect(connection.send('Page.enable')).rejects.toThrow('closed');
    await expect(connection.send('Page.enable')).rejects.toThrow('closed');
  });

  it('times out a call nobody answers', async () => {
    const { url } = await startServer(() => undefined);
    const connection = await connectCdp(url, { callTimeoutMs: 40 });
    await expect(connection.send('Page.enable')).rejects.toThrow('did not answer in time');
    connection.close();
  });

  it('rejects when nothing listens', async () => {
    await expect(connectCdp('ws://127.0.0.1:1')).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
  });
});

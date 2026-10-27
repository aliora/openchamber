import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { StreamHub } from './stream-hub.js';
import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';

const subscriber = () => {
  const res = Object.assign(new EventEmitter(), {
    written: [],
    writeHead: () => {},
    write: (chunk) => { res.written.push(chunk); },
    end: () => {},
  });
  return res;
};

const events = (res) => res.written
  .filter((chunk) => chunk.startsWith('event:'))
  .map((chunk) => JSON.parse(chunk.split('\ndata: ')[1]));

describe('StreamHub', () => {
  it('gives every event an id, which the UI requires of a wire event', () => {
    const hub = new StreamHub();
    const global = subscriber();
    hub.subscribe('global', global);

    hub.broadcast('ses_1', { type: 'session.execution.started', created: 1, data: { sessionID: 'ses_1' } });
    hub.broadcast('ses_1', { id: 'evt_kept', type: 'session.execution.succeeded', created: 2, data: { sessionID: 'ses_1' } });

    const [started, succeeded] = events(global);
    expect(started.id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(started).toMatchObject({ type: 'session.execution.started', data: { sessionID: 'ses_1' } });
    expect(succeeded.id).toBe('evt_kept');
  });

  it('sends a session event to that session and to the global stream with the same id', () => {
    const hub = new StreamHub();
    const global = subscriber();
    const own = subscriber();
    const other = subscriber();
    hub.subscribe('global', global);
    hub.subscribe('ses_1', own);
    hub.subscribe('ses_2', other);

    hub.broadcast('ses_1', { type: 'session.idle', created: 1, data: { sessionID: 'ses_1' } });

    expect(events(own).map((event) => event.id)).toEqual(events(global).map((event) => event.id));
    expect(events(other)).toEqual([]);
  });

  it('writes a heartbeat while the stream is quiet and stops when the subscriber leaves', async () => {
    const hub = new StreamHub({ heartbeatMs: 10 });
    const res = subscriber();
    hub.subscribe('global', res);

    await Bun.sleep(45);
    const beats = res.written.filter((chunk) => chunk === ': keep-alive\n\n').length;
    expect(beats).toBeGreaterThanOrEqual(3);

    res.emit('close');
    const afterClose = res.written.length;
    await Bun.sleep(30);
    expect(res.written.length).toBe(afterClose);
  });

  // The server reads its own `/api/event` through this reader. A stream that
  // goes quiet for longer than the stall timeout is dropped and reopened, and
  // an event sent in that gap is lost: the stalls users saw.
  it('keeps the server\'s own event reader attached through a quiet session', async () => {
    const hub = new StreamHub({ heartbeatMs: 40 });
    const server = http.createServer((req, res) => hub.subscribe('global', res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    let connects = 0;
    const received = [];
    const reader = createUpstreamSseReader({
      signal: controller.signal,
      buildUrl: () => new URL(`http://127.0.0.1:${server.address().port}/api/event`),
      getHeaders: () => ({}),
      stallTimeoutMs: 150,
      onConnect: () => { connects += 1; },
      onEvent: ({ payload }) => { received.push(payload.type); },
    });
    void reader.start();
    try {
      await Bun.sleep(600);
      hub.broadcast('ses_1', { type: 'permission.asked', created: 1, data: { sessionID: 'ses_1' } });
      await Bun.sleep(50);

      expect(connects).toBe(1);
      expect(received).toEqual(['permission.asked']);
    } finally {
      controller.abort();
      reader.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});

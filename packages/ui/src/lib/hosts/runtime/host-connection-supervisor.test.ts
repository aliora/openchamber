import { describe, expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';

import type { HostFetchResult, HostTransport } from '../host-transport';
import { createHostConnectionSupervisor, HOST_CONNECTION_TIMING } from './host-connection-supervisor';
import type { HostStatus } from './types';

type Answer = HostFetchResult | { status: number } | 'queued';

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const createHarness = (answers: Answer[], hidden = false, connect?: () => Promise<void>) => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const requests: string[] = [];
  let streamLive = false;
  const streamListeners = new Set<() => void>();
  const transport: HostTransport = {
    fetch: async (path, { signal }) => {
      requests.push(path);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer === undefined) return { ok: false, reason: 'unreachable' };
      if (answer === 'queued') {
        return new Promise<HostFetchResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }), { once: true });
        });
      }
      return 'status' in answer ? { ok: true, response: new Response(null, { status: answer.status }) } : answer;
    },
    releaseTunnel: () => null,
    close: () => {},
  };
  const status = createStore<HostStatus>()(() => ({ connection: { state: 'connecting' } }));
  const host: Parameters<typeof createHostConnectionSupervisor>[0]['host'] = {
    transport,
    status,
    isStreamLive: () => streamLive,
    subscribeStream: (listener) => {
      streamListeners.add(listener);
      return () => { streamListeners.delete(listener); };
    },
  };
  if (connect) host.connect = connect;
  const supervisor = createHostConnectionSupervisor({
    host,
    environment: { isHidden: () => hidden, isOffline: () => false },
    scheduler: {
      now: () => now,
      setTimer: (run, ms) => {
        nextTimer += 1;
        const id = nextTimer;
        timers.set(id, { at: now + ms, run });
        return () => { timers.delete(id); };
      },
    },
  });
  return {
    supervisor,
    requests,
    connection: () => status.getState().connection,
    setStream: async (live: boolean) => {
      streamLive = live;
      for (const listener of [...streamListeners]) listener();
      await flush();
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
      await flush();
    },
  };
};

describe('watching a host runtime connection', () => {
  test('a live event stream is enough: nothing is probed', async () => {
    const harness = createHarness([{ status: 200 }]);
    await harness.setStream(true);
    harness.supervisor.start();
    await flush();

    expect(harness.connection()).toMatchObject({ state: 'live', via: 'stream' });
    expect(harness.requests).toEqual([]);
    harness.supervisor.stop();
  });

  test('a host that needs a sign-in waits the long backoff before asking again', async () => {
    const harness = createHarness([{ status: 401 }]);
    harness.supervisor.start();
    await flush();

    expect(harness.connection()).toEqual({ state: 'auth-required' });
    await harness.advance(HOST_CONNECTION_TIMING.backoffVisibleCapMs);
    expect(harness.requests).toHaveLength(1);
    await harness.advance(HOST_CONNECTION_TIMING.longBackoffMs);
    expect(harness.requests).toHaveLength(2);
    harness.supervisor.stop();
  });

  test('an unreachable host backs off from one second while the page is visible', async () => {
    const harness = createHarness([{ ok: false, reason: 'unreachable' }]);
    harness.supervisor.start();
    await flush();

    expect(harness.connection()).toEqual({ state: 'backoff', failure: 'unreachable', retryAt: 1_000 });
    await harness.advance(1_000);
    expect(harness.connection()).toEqual({ state: 'backoff', failure: 'unreachable', retryAt: 3_000 });
    harness.supervisor.stop();
  });

  test('a hidden page waits up to five minutes between attempts', async () => {
    const harness = createHarness([{ ok: false, reason: 'unreachable' }], true);
    harness.supervisor.start();
    await flush();
    for (let attempt = 0; attempt < 12; attempt += 1) await harness.advance(HOST_CONNECTION_TIMING.backoffHiddenCapMs);

    const connection = harness.connection();
    expect(connection.state).toBe('backoff');
    if (connection.state !== 'backoff') return;
    expect(connection.retryAt - (12 * HOST_CONNECTION_TIMING.backoffHiddenCapMs)).toBe(HOST_CONNECTION_TIMING.backoffHiddenCapMs);
    harness.supervisor.stop();
  });

  test('the stream coming back ends the backoff at once, and a stop ends the probes', async () => {
    const harness = createHarness([{ ok: false, reason: 'relay-limit' }]);
    harness.supervisor.start();
    await flush();
    expect(harness.connection()).toEqual({ state: 'relay-limit' });

    await harness.setStream(true);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'stream' });
    harness.supervisor.stop();
    await harness.setStream(false);
    await harness.advance(HOST_CONNECTION_TIMING.longBackoffMs);
    expect(harness.requests).toHaveLength(1);
  });

  test('a probe still queued in the browser does not mark a host offline once its stream is up', async () => {
    const harness = createHarness(['queued']);
    harness.supervisor.start();
    await flush();
    expect(harness.requests).toHaveLength(1);

    await harness.setStream(true);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'stream' });

    await harness.advance(HOST_CONNECTION_TIMING.pollTimeoutMs);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'stream' });
    expect(harness.requests).toHaveLength(1);
    harness.supervisor.stop();
  });

  test('connects the host before the first probe and again before a retry after a failure', async () => {
    const order: string[] = [];
    const harness = createHarness([{ ok: false, reason: 'unreachable' }, { status: 200 }], false, async () => { order.push('connect'); });
    const fetch = harness.requests;
    harness.supervisor.start();
    await flush();
    expect(order).toEqual(['connect']);
    expect(fetch).toEqual(['/api/sessions/status']);
    expect(harness.connection().state).toBe('backoff');

    await harness.advance(HOST_CONNECTION_TIMING.backoffBaseMs);
    expect(order).toEqual(['connect', 'connect']);
    expect(fetch).toEqual(['/api/sessions/status', '/api/sessions/status']);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'poll' });

    await harness.advance(HOST_CONNECTION_TIMING.pollVisibleMs);
    expect(order).toEqual(['connect', 'connect']);
    harness.supervisor.stop();
  });

  test('a connect that fails still lets the probe report the host', async () => {
    const harness = createHarness([{ status: 200 }], false, async () => { throw new Error('ssh refused'); });
    harness.supervisor.start();
    await flush();
    expect(harness.requests).toEqual(['/api/sessions/status']);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'poll' });
    harness.supervisor.stop();
  });

  test('a host whose stream is live is not connected again', async () => {
    let connects = 0;
    const harness = createHarness([{ status: 200 }], false, async () => { connects += 1; });
    await harness.setStream(true);
    harness.supervisor.start();
    await flush();
    expect(connects).toBe(0);
    harness.supervisor.stop();
  });

  test('reconnect runs the connect again even while the stream is live', async () => {
    let connects = 0;
    const harness = createHarness([{ status: 200 }], false, async () => { connects += 1; });
    await harness.setStream(true);
    harness.supervisor.start();
    await flush();
    harness.supervisor.reconnect();
    await flush();
    expect(connects).toBe(1);
    expect(harness.connection()).toMatchObject({ state: 'live', via: 'stream' });
    harness.supervisor.stop();
  });
});

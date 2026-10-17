import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createHostMonitor, HOST_MONITOR_TIMING, type HostMonitor, type HostMonitorSink, type MonitorScheduler } from './host-monitor';
import type { HostFetchOptions, HostFetchResult, HostTransport } from './host-transport';
import { useHostsStore } from './hosts-store';
import type { HostDescriptor, HostSessionSummary, MonitoredHost } from './types';

const HOST_ID = 'studio';
const descriptor: HostDescriptor = { id: HOST_ID, label: 'Studio', kind: 'direct', displayUrl: 'https://studio.example', runtimeKey: 'host:studio', monitored: true };
const STREAM = '/api/sessions/summary/stream';
const SNAPSHOT = '/api/sessions/summary';
// Polling far beyond any wait in a test, for tests about the stream alone.
const NO_POLLING = { pollVisibleMs: 1e12, pollHiddenMs: 1e12 };

type FakeEnvironment = { hidden: boolean; offline: boolean };

const row = (id: string, extra: Partial<HostSessionSummary> = {}): HostSessionSummary => ({
  id, title: `Session ${id}`, directory: '/work', engine: 'claude', updatedAt: 1, state: 'idle', ...extra,
});

// Time moves only when a test says so. Due timers fire in order, and the
// monitor's promise chains run between them.
const createFakeScheduler = () => {
  let now = 1_000;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler: MonitorScheduler = {
    now: () => now,
    setTimer(callback, ms) {
      sequence += 1;
      const id = sequence;
      timers.set(id, { at: now + ms, callback });
      return () => { timers.delete(id); };
    },
  };
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
    await flush();
  };
  return { scheduler, advance, flush };
};

type PendingRequest = {
  path: string;
  signal: AbortSignal;
  resolve(result: HostFetchResult): void;
};

const encoder = new TextEncoder();

type WireEvent =
  | { type: 'snapshot'; sessions: HostSessionSummary[] }
  | { type: 'session'; session: HostSessionSummary }
  | { type: 'removed'; id: string };

const eventBytes = (event: WireEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

// A response body the test writes to. It errors when the request aborts, as a fetch body does.
const openBody = (signal: AbortSignal) => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  signal.addEventListener('abort', () => controller?.error(new DOMException('aborted', 'AbortError')));
  return {
    body,
    send: (event: WireEvent) => controller?.enqueue(eventBytes(event)),
    sendRaw: (data: string) => controller?.enqueue(encoder.encode(`data: ${data}\n\n`)),
    comment: () => controller?.enqueue(encoder.encode(': heartbeat\n\n')),
    end: () => controller?.close(),
  };
};

// Like the real transport, a request ends as `aborted` when its signal aborts,
// unless a test needs a transport that answers late anyway.
const createFakeTransport = ({ honorAbort = true } = {}) => {
  const requests: PendingRequest[] = [];
  const transport: HostTransport = {
    fetch: (path: string, options: HostFetchOptions) => new Promise<HostFetchResult>((resolve) => {
      requests.push({ path, signal: options.signal, resolve });
      if (honorAbort) options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }));
    }),
    releaseTunnel: () => null,
    close: () => undefined,
  };
  const latest = () => requests[requests.length - 1];
  return {
    transport,
    requests,
    latest,
    paths: () => requests.map((request) => request.path),
    /** Answers the latest request with an open event stream. */
    openStream() {
      const request = latest();
      const stream = openBody(request.signal);
      request.resolve({ ok: true, response: new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) });
      return stream;
    },
    answer(result: HostFetchResult) {
      latest().resolve(result);
    },
    answerStatus(status: number) {
      latest().resolve({ ok: true, response: new Response('{"error":"no"}', { status }) });
    },
    answerJson(body: { sessions: HostSessionSummary[] }) {
      latest().resolve({ ok: true, response: Response.json(body) });
    },
  };
};

const storeSink = (): HostMonitorSink => ({
  begin: () => useHostsStore.getState().beginGeneration(HOST_ID),
  setConnection: (generation, connection) => useHostsStore.getState().setConnection(HOST_ID, generation, connection),
  applySnapshot: (generation, sessions, at) => useHostsStore.getState().applySnapshot(HOST_ID, generation, sessions, at),
  upsertSession: (generation, session) => useHostsStore.getState().upsertSession(HOST_ID, generation, session),
  removeSession: (generation, sessionId) => useHostsStore.getState().removeSession(HOST_ID, generation, sessionId),
  markError: (generation) => useHostsStore.getState().markSnapshotError(HOST_ID, generation),
});

const host = (): MonitoredHost => {
  const entry = useHostsStore.getState().hosts.find((candidate) => candidate.descriptor.id === HOST_ID);
  if (!entry) throw new Error('host missing from the store');
  return entry;
};

const sessionIds = () => [...host().snapshot.sessions.keys()];

/** The wait the monitor announced for its next stream attempt. */
const retryDelay = (now: number): number => {
  const connection = host().connection;
  if (connection.state !== 'backoff') throw new Error(`expected backoff, got ${connection.state}`);
  return connection.retryAt - now;
};

describe('host monitor', () => {
  let clock: ReturnType<typeof createFakeScheduler>;
  let fake: ReturnType<typeof createFakeTransport>;
  let environment: FakeEnvironment;
  let monitor: HostMonitor | null;

  const startMonitor = (timing: Partial<typeof HOST_MONITOR_TIMING> = {}, transport = fake) => {
    monitor = createHostMonitor({
      transport: transport.transport,
      sink: storeSink(),
      environment: { isHidden: () => environment.hidden, isOffline: () => environment.offline },
      scheduler: clock.scheduler,
      timing: { ...HOST_MONITOR_TIMING, ...timing },
    });
    monitor.start();
    return monitor;
  };

  /** Opens the stream, delivers a snapshot, then drops the stream before it counted as healthy. */
  const loadThenDrop = async (sessions: HostSessionSummary[]) => {
    const stream = fake.openStream();
    stream.send({ type: 'snapshot', sessions });
    await clock.flush();
    stream.end();
    await clock.flush();
  };

  beforeEach(() => {
    useHostsStore.getState().reset();
    useHostsStore.getState().syncHosts([descriptor]);
    clock = createFakeScheduler();
    fake = createFakeTransport();
    environment = { hidden: false, offline: false };
    monitor = null;
  });

  afterEach(() => {
    monitor?.stop();
  });

  test('a fresh load fills the list from the stream snapshot and applies changes after it', async () => {
    startMonitor();
    await clock.flush();
    expect(host().snapshot.status).toBe('loading');
    expect(host().connection).toEqual({ state: 'connecting' });
    expect(fake.paths()).toEqual([STREAM]);

    const stream = fake.openStream();
    stream.send({ type: 'snapshot', sessions: [row('a'), row('b', { state: 'running' })] });
    await clock.flush();
    expect(host().snapshot).toMatchObject({ status: 'ready', lastCompleteAt: 1_000 });
    expect(sessionIds()).toEqual(['a', 'b']);
    expect(host().connection).toEqual({ state: 'live', since: 1_000, via: 'stream' });

    const untouched = host().snapshot.sessions.get('b');
    stream.send({ type: 'session', session: row('a', { state: 'waiting-permission' }) });
    stream.send({ type: 'session', session: row('c', { title: 'New' }) });
    stream.send({ type: 'removed', id: 'b' });
    await clock.flush();
    expect(host().snapshot.sessions.get('a')?.state).toBe('waiting-permission');
    expect(sessionIds()).toEqual(['a', 'c']);
    expect(untouched?.state).toBe('running');
  });

  test('an empty snapshot is a complete, empty list', async () => {
    startMonitor();
    await clock.flush();
    fake.openStream().send({ type: 'snapshot', sessions: [] });
    await clock.flush();
    expect(host().snapshot).toMatchObject({ status: 'ready', lastCompleteAt: 1_000 });
    expect(host().snapshot.sessions.size).toBe(0);
  });

  test('a dropped stream keeps the last list, marked stale, and retries with growing waits', async () => {
    startMonitor(NO_POLLING);
    await clock.flush();
    await loadThenDrop([row('a')]);

    expect(host().snapshot.status).toBe('error');
    expect(sessionIds()).toEqual(['a']);
    expect(host().connection).toEqual({ state: 'backoff', failure: 'interrupted', retryAt: 1_000 + HOST_MONITOR_TIMING.backoffBaseMs });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const delay = retryDelay(clock.scheduler.now());
      delays.push(delay);
      await clock.advance(delay);
      expect(fake.latest().path).toBe(STREAM);
      fake.answer({ ok: false, reason: 'unreachable' });
      await clock.flush();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(host().connection).toMatchObject({ failure: 'unreachable' });
    expect(sessionIds()).toEqual(['a']);
  });

  test('a healthy stream resets the backoff', async () => {
    startMonitor(NO_POLLING);
    await clock.flush();
    fake.answer({ ok: false, reason: 'unreachable' });
    await clock.advance(1_000);
    fake.answer({ ok: false, reason: 'unreachable' });
    await clock.flush();
    expect(retryDelay(clock.scheduler.now())).toBe(2_000);

    await clock.advance(2_000);
    const stream = fake.openStream();
    stream.send({ type: 'snapshot', sessions: [] });
    await clock.advance(HOST_MONITOR_TIMING.healthyStreamMs);
    stream.end();
    await clock.advance(HOST_MONITOR_TIMING.reconnectAfterHealthyMs);
    fake.answer({ ok: false, reason: 'unreachable' });
    await clock.flush();
    expect(retryDelay(clock.scheduler.now())).toBe(1_000);
  });

  test('a stream that goes quiet past the heartbeat window is dropped and retried', async () => {
    startMonitor(NO_POLLING);
    await clock.flush();
    const stream = fake.openStream();
    stream.send({ type: 'snapshot', sessions: [row('a')] });
    await clock.advance(HOST_MONITOR_TIMING.streamStallMs - 1);
    stream.comment();
    await clock.advance(HOST_MONITOR_TIMING.streamStallMs - 1);
    expect(host().connection.state).toBe('live');

    await clock.advance(1);
    expect(host().connection).toMatchObject({ state: 'backoff', failure: 'interrupted' });
    expect(sessionIds()).toEqual(['a']);
  });

  test('waits longer while the page is hidden or offline', async () => {
    environment.hidden = true;
    startMonitor(NO_POLLING);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await clock.flush();
      fake.answer({ ok: false, reason: 'unreachable' });
      await clock.flush();
      delays.push(retryDelay(clock.scheduler.now()));
      if (attempt === 9) {
        environment.hidden = false;
        environment.offline = true;
      }
      await clock.advance(delays[delays.length - 1]);
    }
    expect(delays.slice(5)).toEqual([32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);

    environment.offline = false;
    await clock.flush();
    fake.answer({ ok: false, reason: 'unreachable' });
    await clock.flush();
    expect(retryDelay(clock.scheduler.now())).toBe(HOST_MONITOR_TIMING.backoffVisibleCapMs);
  });

  test('a permanent 4xx waits the long backoff without polling; 408 and 429 retry soon', async () => {
    startMonitor();
    await clock.flush();
    fake.answerStatus(400);
    await clock.flush();
    expect(host().connection).toEqual({ state: 'backoff', failure: 'rejected', retryAt: 1_000 + HOST_MONITOR_TIMING.longBackoffMs });
    await clock.advance(HOST_MONITOR_TIMING.longBackoffMs);
    expect(fake.paths()).toEqual([STREAM, STREAM]);

    fake.answerStatus(429);
    await clock.flush();
    expect(host().connection).toMatchObject({ state: 'backoff', failure: 'server-error' });
    expect(retryDelay(clock.scheduler.now())).toBe(2_000);

    await clock.advance(2_000);
    fake.answerStatus(408);
    await clock.flush();
    expect(host().connection).toMatchObject({ state: 'backoff', failure: 'server-error' });
    expect(retryDelay(clock.scheduler.now())).toBe(4_000);
  });

  test('401 asks for sign-in, 404 marks the host incompatible, the relay limit has its own state', async () => {
    startMonitor(NO_POLLING);
    await clock.flush();
    await loadThenDrop([row('a')]);
    await clock.advance(HOST_MONITOR_TIMING.backoffBaseMs);

    fake.answerStatus(401);
    await clock.flush();
    expect(host().connection).toEqual({ state: 'auth-required' });
    expect(host().snapshot.status).toBe('error');
    expect(sessionIds()).toEqual(['a']);

    await clock.advance(HOST_MONITOR_TIMING.longBackoffMs);
    fake.answerStatus(404);
    await clock.flush();
    expect(host().connection).toEqual({ state: 'incompatible' });

    await clock.advance(HOST_MONITOR_TIMING.longBackoffMs);
    fake.answer({ ok: false, reason: 'relay-limit' });
    await clock.flush();
    expect(host().connection).toEqual({ state: 'relay-limit' });
    expect(sessionIds()).toEqual(['a']);
  });

  test('a waiting monitor retries at once when woken', async () => {
    startMonitor();
    await clock.flush();
    fake.answerStatus(401);
    await clock.flush();
    expect(host().connection).toEqual({ state: 'auth-required' });

    monitor?.wake();
    await clock.flush();
    expect(fake.paths()).toEqual([STREAM, STREAM]);
  });

  test('polls the snapshot while the stream is down, every 10s visible and 60s hidden', async () => {
    startMonitor({ backoffBaseMs: 120_000, backoffVisibleCapMs: 120_000 });
    await clock.flush();
    await loadThenDrop([row('a')]);
    expect(host().connection).toMatchObject({ state: 'backoff', failure: 'interrupted' });

    await clock.advance(HOST_MONITOR_TIMING.pollVisibleMs);
    expect(fake.latest().path).toBe(SNAPSHOT);
    fake.answerJson({ sessions: [row('a', { state: 'running' }), row('b')] });
    await clock.flush();
    expect(host().connection).toEqual({ state: 'live', since: 11_000, via: 'poll' });
    expect(host().snapshot.status).toBe('ready');
    expect(host().snapshot.sessions.get('a')?.state).toBe('running');
    expect(sessionIds()).toEqual(['a', 'b']);

    // A failed poll ends the polling's claim to be live; the list stays.
    await clock.advance(HOST_MONITOR_TIMING.pollVisibleMs);
    environment.hidden = true;
    fake.answerStatus(503);
    await clock.flush();
    expect(host().connection).toEqual({ state: 'backoff', failure: 'interrupted', retryAt: 121_000 });
    expect(sessionIds()).toEqual(['a', 'b']);

    const polls = () => fake.paths().filter((path) => path === SNAPSHOT).length;
    const before = polls();
    await clock.advance(HOST_MONITOR_TIMING.pollVisibleMs);
    expect(polls()).toBe(before);
    await clock.advance(HOST_MONITOR_TIMING.pollHiddenMs - HOST_MONITOR_TIMING.pollVisibleMs);
    expect(polls()).toBe(before + 1);
  });

  test('a completion from a run that was stopped changes nothing', async () => {
    const late = createFakeTransport({ honorAbort: false });
    const current = startMonitor({}, late);
    await clock.flush();
    const stale = late.requests[0];
    current.stop();
    current.start();
    await clock.flush();
    expect(late.paths()).toEqual([STREAM, STREAM]);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(eventBytes({ type: 'snapshot', sessions: [row('stale')] }));
      },
    });
    stale.resolve({ ok: true, response: new Response(body, { status: 200 }) });
    await clock.flush();
    expect(host().snapshot.status).toBe('loading');
    expect(host().snapshot.sessions.size).toBe(0);

    // The store refuses a write that names an earlier generation as well.
    const generation = host().snapshot.generation;
    useHostsStore.getState().applySnapshot(HOST_ID, generation - 1, [row('stale')], 5);
    useHostsStore.getState().setConnection(HOST_ID, generation - 1, { state: 'incompatible' });
    expect(host().snapshot.status).toBe('loading');
    expect(host().connection).toEqual({ state: 'connecting' });

    const fresh = openBody(late.latest().signal);
    late.latest().resolve({ ok: true, response: new Response(fresh.body, { status: 200 }) });
    fresh.send({ type: 'snapshot', sessions: [row('fresh')] });
    await clock.flush();
    expect(sessionIds()).toEqual(['fresh']);
  });

  test('a body that does not parse is a failure, never an empty list', async () => {
    startMonitor();
    await clock.flush();
    fake.openStream().sendRaw(JSON.stringify({ type: 'snapshot', sessions: [{ id: 'a', state: 'thinking' }] }));
    await clock.flush();
    expect(host().snapshot.status).toBe('error');
    expect(host().snapshot.sessions.size).toBe(0);
    expect(host().connection).toMatchObject({ state: 'backoff', failure: 'invalid-response' });
  });
});

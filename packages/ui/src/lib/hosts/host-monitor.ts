// Keeps one host's session list current. The summary stream is read with
// `fetch`, so the bearer header works through every transport; it opens with
// a complete snapshot and then sends one row per change. While the stream is
// down, the snapshot route is polled between reconnect attempts.
//
// Every write names the generation `sink.begin()` handed out when this run
// started. `stop()` ends the run, and the store drops writes from any
// generation but the host's current one, so a request that completes after a
// runtime switch changes nothing.

import { z } from 'zod';

import type { HostTransport } from './host-transport';
import type { HostConnection, HostFailure, HostProject, HostSessionSummary } from './types';

const SUMMARY_PATH = '/api/sessions/summary';
const SUMMARY_STREAM_PATH = '/api/sessions/summary/stream';

export const HOST_MONITOR_TIMING = {
  pollVisibleMs: 10_000,
  pollHiddenMs: 60_000,
  backoffBaseMs: 1_000,
  backoffVisibleCapMs: 30_000,
  /** The cap while the page is hidden or offline. */
  backoffHiddenCapMs: 300_000,
  /** The wait after a permanent failure: 4xx, auth, a host without the routes, the relay limit. */
  longBackoffMs: 300_000,
  /** The server sends a heartbeat every 15s; three missed ones end the stream. */
  streamStallMs: 45_000,
  /** A stream that stayed open this long proves the host healthy and resets the backoff. */
  healthyStreamMs: 30_000,
  reconnectAfterHealthyMs: 1_000,
  pollTimeoutMs: 20_000,
};

const sessionSummarySchema = z.object({
  id: z.string().min(1),
  parentID: z.string().optional(),
  title: z.string(),
  directory: z.string(),
  engine: z.string(),
  updatedAt: z.number(),
  state: z.enum(['idle', 'running', 'waiting-permission', 'waiting-input', 'failed']),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  chat: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  path: z.string(),
  order: z.number(),
  isDefault: z.boolean(),
});

const snapshotBodySchema = z.object({ sessions: z.array(sessionSummarySchema), projects: z.array(projectSchema).optional() });

const streamEventSchema = z.discriminatedUnion('type', [
  snapshotBodySchema.extend({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('session'), session: sessionSummarySchema }),
  z.object({ type: z.literal('removed'), id: z.string().min(1) }),
]);

type StreamEvent = z.infer<typeof streamEventSchema>;

const parseStreamEvent = (data: string): StreamEvent | null => {
  try {
    const parsed = streamEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Where the monitor writes. Each call names the generation of the run that makes it. */
export type HostMonitorSink = {
  begin(): number;
  setConnection(generation: number, connection: HostConnection): void;
  applySnapshot(generation: number, sessions: readonly HostSessionSummary[], at: number, projects?: readonly HostProject[]): void;
  upsertSession(generation: number, session: HostSessionSummary): void;
  removeSession(generation: number, sessionId: string): void;
  /** The last attempt failed: the list stays as it was, marked stale. */
  markError(generation: number): void;
};

export type MonitorEnvironment = {
  isHidden(): boolean;
  isOffline(): boolean;
};

export type MonitorScheduler = {
  now(): number;
  /** Runs `callback` after `ms`; the returned function cancels it. */
  setTimer(callback: () => void, ms: number): () => void;
};

export type HostMonitor = {
  start(): void;
  stop(): void;
  /** Ends the current wait and tries again now: the page became visible or went online, or the user asked. */
  wake(): void;
};

type BlockedConnection = Extract<HostConnection, { state: 'auth-required' | 'incompatible' | 'relay-limit' }>;

type AttemptFailure =
  | { kind: 'blocked'; connection: BlockedConnection }
  | { kind: 'retry'; failure: HostFailure; permanent: boolean };

const classifyStatus = (status: number): AttemptFailure => {
  if (status === 401 || status === 403) return { kind: 'blocked', connection: { state: 'auth-required' } };
  if (status === 404) return { kind: 'blocked', connection: { state: 'incompatible' } };
  if (status === 408 || status === 429 || status >= 500) return { kind: 'retry', failure: 'server-error', permanent: false };
  if (status >= 400) return { kind: 'retry', failure: 'rejected', permanent: true };
  return { kind: 'retry', failure: 'server-error', permanent: false };
};

const transportFailure = (reason: 'unreachable' | 'relay-limit'): AttemptFailure => (
  reason === 'relay-limit'
    ? { kind: 'blocked', connection: { state: 'relay-limit' } }
    : { kind: 'retry', failure: 'unreachable', permanent: false }
);

const INVALID_RESPONSE: AttemptFailure = { kind: 'retry', failure: 'invalid-response', permanent: true };

type StreamOutcome =
  | { kind: 'stopped' }
  | { kind: 'healthy' }
  | { kind: 'failed'; failure: AttemptFailure };

/**
 * Reads `data:` payloads of a `text/event-stream` body. `onChunk` runs for
 * every chunk, comments included. Returns when the body ends or `onData`
 * returns false; rejects when the read fails or is aborted.
 */
const readEventStream = async (
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  onData: (data: string) => boolean,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onChunk();
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          const data = dataLines.join('\n');
          dataLines = [];
          if (data && !onData(data)) return;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
};

type HostMonitorOptions = {
  transport: HostTransport;
  sink: HostMonitorSink;
  environment: MonitorEnvironment;
  scheduler: MonitorScheduler;
  timing?: typeof HOST_MONITOR_TIMING;
};

export const createHostMonitor = ({
  transport,
  sink,
  environment,
  scheduler,
  timing = HOST_MONITOR_TIMING,
}: HostMonitorOptions): HostMonitor => {
  let generation: number | null = null;
  let inFlight: AbortController | null = null;
  let interruptWait: (() => void) | null = null;
  // True while polling keeps the list current although the stream is down.
  let pollLive = false;

  const isCurrent = (run: number): boolean => generation === run;

  const wait = (ms: number): Promise<'elapsed' | 'woken'> => new Promise((resolve) => {
    let settled = false;
    const settle = (result: 'elapsed' | 'woken') => {
      if (settled) return;
      settled = true;
      cancel();
      if (interruptWait === wake) interruptWait = null;
      resolve(result);
    };
    const cancel = scheduler.setTimer(() => settle('elapsed'), ms);
    const wake = () => settle('woken');
    interruptWait = wake;
  });

  const backoffDelay = (failures: number, permanent: boolean): number => {
    if (permanent) return timing.longBackoffMs;
    const cap = environment.isHidden() || environment.isOffline() ? timing.backoffHiddenCapMs : timing.backoffVisibleCapMs;
    return Math.min(timing.backoffBaseMs * 2 ** (failures - 1), cap);
  };

  const streamOnce = async (run: number): Promise<StreamOutcome> => {
    const controller = new AbortController();
    inFlight = controller;
    let stalled = false;
    let cancelStall = () => {};
    // Armed before the request too: a host that never answers counts as stalled.
    const armStall = () => {
      cancelStall();
      cancelStall = scheduler.setTimer(() => {
        stalled = true;
        controller.abort();
      }, timing.streamStallMs);
    };
    armStall();

    let snapshotSeen = false;
    let invalid = false;
    let openedAt = 0;
    try {
      const result = await transport.fetch(SUMMARY_STREAM_PATH, { accept: 'text/event-stream', signal: controller.signal });
      if (!isCurrent(run)) return { kind: 'stopped' };
      if (!result.ok) {
        if (result.reason !== 'aborted') return { kind: 'failed', failure: transportFailure(result.reason) };
        return stalled ? { kind: 'failed', failure: transportFailure('unreachable') } : { kind: 'stopped' };
      }
      const { response } = result;
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        return { kind: 'failed', failure: response.ok ? INVALID_RESPONSE : classifyStatus(response.status) };
      }
      openedAt = scheduler.now();
      await readEventStream(response.body, armStall, (data) => {
        if (!isCurrent(run)) return false;
        const event = parseStreamEvent(data);
        if (!event || (!snapshotSeen && event.type !== 'snapshot')) {
          invalid = true;
          return false;
        }
        if (event.type === 'snapshot') {
          sink.applySnapshot(run, event.sessions, scheduler.now(), event.projects);
          if (!snapshotSeen) sink.setConnection(run, { state: 'live', since: scheduler.now(), via: 'stream' });
          snapshotSeen = true;
          pollLive = false;
        } else if (event.type === 'session') {
          sink.upsertSession(run, event.session);
        } else {
          sink.removeSession(run, event.id);
        }
        return true;
      });
    } catch {
      // A dropped connection or an abort; told apart below.
    } finally {
      cancelStall();
      if (inFlight === controller) inFlight = null;
    }

    if (!isCurrent(run)) return { kind: 'stopped' };
    if (invalid) return { kind: 'failed', failure: INVALID_RESPONSE };
    if (snapshotSeen && !stalled && scheduler.now() - openedAt >= timing.healthyStreamMs) return { kind: 'healthy' };
    return { kind: 'failed', failure: { kind: 'retry', failure: 'interrupted', permanent: false } };
  };

  const pollOnce = async (run: number): Promise<'ok' | 'stopped' | AttemptFailure> => {
    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const cancelTimeout = scheduler.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timing.pollTimeoutMs);
    try {
      const result = await transport.fetch(SUMMARY_PATH, { accept: 'application/json', signal: controller.signal });
      if (!isCurrent(run)) return 'stopped';
      if (!result.ok) {
        if (result.reason !== 'aborted') return transportFailure(result.reason);
        return timedOut ? transportFailure('unreachable') : 'stopped';
      }
      const { response } = result;
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return classifyStatus(response.status);
      }
      const parsed = snapshotBodySchema.safeParse(await response.json().catch(() => null));
      if (!isCurrent(run)) return 'stopped';
      if (!parsed.success) return INVALID_RESPONSE;
      sink.applySnapshot(run, parsed.data.sessions, scheduler.now(), parsed.data.projects);
      return 'ok';
    } finally {
      cancelTimeout();
      if (inFlight === controller) inFlight = null;
    }
  };

  const block = (run: number, connection: BlockedConnection) => {
    pollLive = false;
    sink.setConnection(run, connection);
    sink.markError(run);
  };

  const enterBackoff = (run: number, failure: HostFailure, retryAt: number) => {
    pollLive = false;
    sink.setConnection(run, { state: 'backoff', failure, retryAt });
    sink.markError(run);
  };

  /** Waits for the next stream attempt, polling the snapshot meanwhile when that can help. */
  const waitForRetry = async (run: number, delayMs: number, failure: HostFailure, poll: boolean): Promise<'retry' | 'stopped'> => {
    const deadline = scheduler.now() + delayMs;
    for (;;) {
      const remaining = deadline - scheduler.now();
      if (remaining <= 0) return 'retry';
      const interval = environment.isHidden() ? timing.pollHiddenMs : timing.pollVisibleMs;
      const woke = await wait(poll ? Math.min(interval, remaining) : remaining);
      if (!isCurrent(run)) return 'stopped';
      if (woke === 'woken' || !poll || scheduler.now() >= deadline) return 'retry';

      const polled = await pollOnce(run);
      if (polled === 'stopped') return 'stopped';
      if (polled === 'ok') {
        if (!pollLive) sink.setConnection(run, { state: 'live', since: scheduler.now(), via: 'poll' });
        pollLive = true;
      } else if (polled.kind === 'blocked') {
        block(run, polled.connection);
        return 'retry';
      } else if (pollLive) {
        enterBackoff(run, failure, deadline);
      }
    }
  };

  const run = async (current: number): Promise<void> => {
    let failures = 0;
    while (isCurrent(current)) {
      const outcome = await streamOnce(current);
      if (outcome.kind === 'stopped' || !isCurrent(current)) return;
      if (outcome.kind === 'healthy') {
        failures = 0;
        await wait(timing.reconnectAfterHealthyMs);
        continue;
      }

      failures += 1;
      const { failure } = outcome;
      if (failure.kind === 'blocked') {
        block(current, failure.connection);
        await wait(timing.longBackoffMs);
        continue;
      }
      const delayMs = backoffDelay(failures, failure.permanent);
      // Polling that already keeps the list current stays the connection's state.
      if (!pollLive) enterBackoff(current, failure.failure, scheduler.now() + delayMs);
      if (await waitForRetry(current, delayMs, failure.failure, !failure.permanent) === 'stopped') return;
    }
  };

  return {
    start() {
      if (generation !== null) return;
      const current = sink.begin();
      generation = current;
      pollLive = false;
      void run(current);
    },
    stop() {
      generation = null;
      inFlight?.abort();
      inFlight = null;
      interruptWait?.();
    },
    wake() {
      interruptWait?.();
    },
  };
};

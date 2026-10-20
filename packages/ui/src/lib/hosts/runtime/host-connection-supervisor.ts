import type { StoreApi } from 'zustand/vanilla';

import type { HostTransport } from '../host-transport';
import type { HostConnection, HostFailure } from '../types';
import type { HostStatus } from './types';

const PROBE_PATH = '/api/sessions/status';

export const HOST_CONNECTION_TIMING = {
  pollVisibleMs: 10_000,
  pollHiddenMs: 60_000,
  backoffBaseMs: 1_000,
  backoffVisibleCapMs: 30_000,
  backoffHiddenCapMs: 300_000,
  longBackoffMs: 300_000,
  pollTimeoutMs: 20_000,
};

export type MonitorEnvironment = {
  isHidden(): boolean;
  isOffline(): boolean;
};

export type MonitorScheduler = {
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
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

type SupervisedHost = {
  transport: HostTransport;
  status: StoreApi<HostStatus>;
  isStreamLive(): boolean;
  subscribeStream(listener: () => void): () => void;
  connect?(): Promise<void>;
};

export type HostConnectionSupervisor = {
  start(): void;
  stop(): void;
  wake(): void;
  reconnect(): void;
};

type SupervisorOptions = {
  host: SupervisedHost;
  environment: MonitorEnvironment;
  scheduler: MonitorScheduler;
  timing?: typeof HOST_CONNECTION_TIMING;
};

type ProbeResult = 'ok' | 'stopped' | AttemptFailure;

const sameConnection = (left: HostConnection, right: HostConnection): boolean => {
  if (left.state !== right.state) return false;
  if (left.state === 'live' && right.state === 'live') return left.via === right.via;
  if (left.state === 'backoff' && right.state === 'backoff') return left.failure === right.failure && left.retryAt === right.retryAt;
  return true;
};

export const createHostConnectionSupervisor = ({
  host,
  environment,
  scheduler,
  timing = HOST_CONNECTION_TIMING,
}: SupervisorOptions): HostConnectionSupervisor => {
  let generation = 0;
  let running = false;
  let inFlight: AbortController | null = null;
  let interruptWait: (() => void) | null = null;
  let unsubscribeStream: (() => void) | null = null;
  let connectPending = false;
  let connectForced = false;

  const isCurrent = (run: number): boolean => running && generation === run;

  const setConnection = (connection: HostConnection): void => {
    if (!sameConnection(host.status.getState().connection, connection)) host.status.setState({ connection });
  };

  const wait = (ms: number | null): Promise<void> => new Promise((resolve) => {
    let settled = false;
    let cancel = () => {};
    const settle = () => {
      if (settled) return;
      settled = true;
      cancel();
      if (interruptWait === settle) interruptWait = null;
      resolve();
    };
    if (ms !== null) cancel = scheduler.setTimer(settle, ms);
    interruptWait = settle;
  });

  const probe = async (run: number): Promise<ProbeResult> => {
    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const cancelTimeout = scheduler.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timing.pollTimeoutMs);
    try {
      const result = await host.transport.fetch(PROBE_PATH, { accept: 'application/json', signal: controller.signal });
      if (!isCurrent(run)) return 'stopped';
      if (!result.ok) {
        if (result.reason !== 'aborted') return transportFailure(result.reason);
        return timedOut ? transportFailure('unreachable') : 'stopped';
      }
      void result.response.body?.cancel().catch(() => undefined);
      return result.response.ok ? 'ok' : classifyStatus(result.response.status);
    } finally {
      cancelTimeout();
      if (inFlight === controller) inFlight = null;
    }
  };

  const backoffDelay = (failures: number, permanent: boolean): number => {
    if (permanent) return timing.longBackoffMs;
    const cap = environment.isHidden() || environment.isOffline() ? timing.backoffHiddenCapMs : timing.backoffVisibleCapMs;
    return Math.min(timing.backoffBaseMs * 2 ** (failures - 1), cap);
  };

  const connect = async (): Promise<void> => {
    try {
      await host.connect?.();
    } catch {
      return;
    }
  };

  const run = async (current: number): Promise<void> => {
    let failures = 0;
    while (isCurrent(current)) {
      if (host.connect && (connectForced || (connectPending && !host.isStreamLive()))) {
        connectForced = false;
        connectPending = false;
        await connect();
        continue;
      }
      if (host.isStreamLive()) {
        failures = 0;
        setConnection({ state: 'live', since: scheduler.now(), via: 'stream' });
        await wait(null);
        continue;
      }
      const result = await probe(current);
      if (!isCurrent(current)) return;
      if (host.isStreamLive()) continue;
      if (result === 'stopped') return;
      if (result === 'ok') {
        failures = 0;
        setConnection({ state: 'live', since: scheduler.now(), via: 'poll' });
        await wait(environment.isHidden() ? timing.pollHiddenMs : timing.pollVisibleMs);
        continue;
      }
      failures += 1;
      connectPending = true;
      if (result.kind === 'blocked') {
        setConnection(result.connection);
        await wait(timing.longBackoffMs);
        continue;
      }
      const delay = backoffDelay(failures, result.permanent);
      setConnection({ state: 'backoff', failure: result.failure, retryAt: scheduler.now() + delay });
      await wait(delay);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      generation += 1;
      connectPending = true;
      connectForced = false;
      let streamLive = host.isStreamLive();
      unsubscribeStream = host.subscribeStream(() => {
        const live = host.isStreamLive();
        if (live === streamLive) return;
        streamLive = live;
        if (live) inFlight?.abort();
        interruptWait?.();
      });
      void run(generation);
    },
    stop() {
      running = false;
      unsubscribeStream?.();
      unsubscribeStream = null;
      inFlight?.abort();
      inFlight = null;
      interruptWait?.();
    },
    wake() {
      interruptWait?.();
    },
    reconnect() {
      connectForced = true;
      interruptWait?.();
    },
  };
};

import React from 'react';
import { z } from 'zod';
import { hostRuntimeFetch } from '@/lib/hosts/runtime/host-fetch';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { ENGINE_ACTION_IDS, type EngineActionId, type EngineId } from '@/components/setup-wizard/engineSetupModel';

export type JobLogLine = { stream: 'stdout' | 'stderr' | 'system'; text: string };

export type JobState = 'idle' | 'running' | 'completed' | 'failed';

export type JobEvent =
  | { type: 'log'; line: JobLogLine }
  | { type: 'status'; state: JobState; action: EngineActionId | null };

export type JobLog = { state: JobState; action: EngineActionId | null; lines: JobLogLine[] };

const MAX_LINES = 500;
const RECONNECT_MS = 5000;

const logSchema = z.object({
  stream: z.enum(['stdout', 'stderr', 'system']).catch('stdout'),
  text: z.string(),
});

const statusSchema = z.object({
  state: z.string().catch('idle'),
  action: z.enum(ENGINE_ACTION_IDS).nullable().optional().catch(undefined),
});

const toJobState = (state: string): JobState => {
  if (state === 'installing' || state === 'running') return 'running';
  if (state === 'completed' || state === 'failed') return state;
  return 'idle';
};

export const parseJobEvent = (event: string, data: string): JobEvent | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (event === 'log') {
    const parsed = logSchema.safeParse(payload);
    return parsed.success ? { type: 'log', line: parsed.data } : null;
  }
  if (event === 'status') {
    const parsed = statusSchema.safeParse(payload);
    return parsed.success ? { type: 'status', state: toJobState(parsed.data.state), action: parsed.data.action ?? null } : null;
  }
  return null;
};

export const createEventStreamParser = (onEvent: (event: string, data: string) => void) => {
  let buffer = '';
  let event = 'message';
  let dataLines: string[] = [];
  const dispatchLine = (line: string) => {
    if (line === '') {
      if (dataLines.length > 0) onEvent(event, dataLines.join('\n'));
      event = 'message';
      dataLines = [];
      return;
    }
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      dispatchLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  };
};

export const applyJobEvent = (log: JobLog, event: JobEvent): JobLog => {
  if (event.type === 'log') {
    const lines = [...log.lines, event.line];
    return { ...log, lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines };
  }
  const startsNewJob = event.state === 'running' && log.state !== 'running';
  return { state: event.state, action: event.action ?? log.action, lines: startsNewJob ? [] : log.lines };
};

const EMPTY_LOG: JobLog = { state: 'idle', action: null, lines: [] };

const readStream = async (host: HostRuntime, engine: EngineId, signal: AbortSignal, onEvent: (event: JobEvent) => void): Promise<void> => {
  const response = await hostRuntimeFetch(host, `/api/engines/${engine}/install/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Log stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const push = createEventStreamParser((name, data) => {
    const event = parseJobEvent(name, data);
    if (event) onEvent(event);
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
};

export const useEngineJobLog = (host: HostRuntime, engine: EngineId, onSettled: () => void): JobLog => {
  const [log, setLog] = React.useState<JobLog>(EMPTY_LOG);
  const onSettledRef = React.useRef(onSettled);
  React.useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let wasRunning = false;
    setLog(EMPTY_LOG);
    const handle = (event: JobEvent) => {
      setLog((current) => applyJobEvent(current, event));
      if (event.type !== 'status') return;
      if (wasRunning && event.state !== 'running') onSettledRef.current();
      wasRunning = event.state === 'running';
    };
    const connect = () => {
      readStream(host, engine, controller.signal, handle)
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) timer = window.setTimeout(connect, RECONNECT_MS);
        });
    };
    connect();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [engine, host]);

  return log;
};

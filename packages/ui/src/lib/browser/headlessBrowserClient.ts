import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isBrowserCapabilityKnown, setHeadlessBrowserAvailable } from './hostCapability';

const API_ROOT = '/api/headless-browser';

export type HeadlessInputEvent =
  | { kind: 'mouse'; type: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'none' | 'left' | 'middle' | 'right'; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code: string; keyCode: number; modifiers: number }
  | { kind: 'text'; text: string };

export type HeadlessStreamMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'meta'; url: string; title: string; loading: boolean }
  | { type: 'crashed' }
  | { type: 'closed' };

export type HeadlessCommand =
  | { command: 'navigate'; url: string; timeoutMs?: number }
  | { command: 'evaluate'; script: string }
  | { command: 'settle'; timeoutMs?: number }
  | { command: 'click'; x: number; y: number }
  | { command: 'type'; text: string; submit: boolean }
  | { command: 'capture' }
  | { command: 'history'; direction: 'back' | 'forward' }
  | { command: 'reload' }
  | { command: 'viewport'; fill: true }
  | { command: 'viewport'; fill: false; width: number; height: number }
  | { command: 'fit'; width: number; height: number }
  | { command: 'info' };

export type HeadlessPageInfo = {
  url: string;
  title: string;
  loading: boolean;
  problems: Array<{ level: 'warning' | 'error'; message: string; source: string }>;
};

export type HeadlessCommandSender = <T>(command: HeadlessCommand) => Promise<T>;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const fnv1a = (value: string, seed: number): string => {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

export const headlessTabKey = (directory: string, tabId: string): string => {
  const source = `${directory}\u0000${tabId}`;
  return `hb-${fnv1a(source, FNV_OFFSET)}${fnv1a(source, FNV_OFFSET ^ 0x9e3779b9)}`;
};

const tabPath = (key: string, suffix: string): string => `${API_ROOT}/tabs/${encodeURIComponent(key)}/${suffix}`;

const readError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error ? body.error : `Server browser request failed (${response.status})`;
  } catch {
    return `Server browser request failed (${response.status})`;
  }
};

export const createHeadlessCommandSender = (key: string): HeadlessCommandSender => async <T>(command: HeadlessCommand): Promise<T> => {
  const response = await runtimeFetch(tabPath(key, 'command'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as T;
};

export const sendHeadlessInput = async (key: string, event: HeadlessInputEvent): Promise<void> => {
  await runtimeFetch(tabPath(key, 'input'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => undefined);
};

export const closeHeadlessTab = async (key: string): Promise<void> => {
  await runtimeFetch(`${API_ROOT}/tabs/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
};

export const openHeadlessStream = (
  key: string,
  onMessage: (message: HeadlessStreamMessage) => void,
  onError: () => void,
): (() => void) => {
  const source = new EventSource(getRuntimeUrlResolver().sse(tabPath(key, 'stream')));
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data) as HeadlessStreamMessage);
    } catch {
      return;
    }
  };
  source.onerror = onError;
  return () => source.close();
};

let priming: Promise<void> | null = null;

export const primeBrowserCapability = (): Promise<void> => {
  if (isBrowserCapabilityKnown()) return Promise.resolve();
  priming ??= runtimeFetch(`${API_ROOT}/status`)
    .then(async (response) => {
      const status = response.ok ? await response.json() as { available?: unknown } : null;
      setHeadlessBrowserAvailable(status?.available === true);
    })
    .catch(() => setHeadlessBrowserAvailable(false));
  return priming;
};

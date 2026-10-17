import { WebSocket } from 'ws';

const CALL_TIMEOUT_MS = 30_000;

export class CdpError extends Error {
  constructor(message, code = 'CDP_ERROR') {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export const connectCdp = (url, { WebSocketImpl = WebSocket, callTimeoutMs = CALL_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocketImpl(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  let closed = false;

  const failAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const emit = (event, sessionId) => {
    const handlers = listeners.get(event.method);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(event.params ?? {}, sessionId);
  };

  const onMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(message.error.message || 'CDP call failed', 'CDP_ERROR'));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') emit(message, message.sessionId ?? null);
  };

  const connection = {
    send(method, params = {}, sessionId = null) {
      if (closed) return Promise.reject(new CdpError('The browser connection is closed', 'CLOSED'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new CdpError(`${method} did not answer in time`, 'TIMEOUT'));
        }, callTimeoutMs);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method)?.delete(handler);
    },
    onClose(handler) {
      socket.on('close', handler);
    },
    close() {
      if (closed) return;
      closed = true;
      failAll(new CdpError('The browser connection is closed', 'CLOSED'));
      socket.close();
    },
    get isOpen() {
      return !closed;
    },
  };

  socket.on('message', onMessage);
  socket.on('close', () => {
    closed = true;
    failAll(new CdpError('The browser connection is closed', 'CLOSED'));
  });
  socket.once('error', (error) => reject(new CdpError(error.message, 'CONNECT_FAILED')));
  socket.once('open', () => resolve(connection));
});

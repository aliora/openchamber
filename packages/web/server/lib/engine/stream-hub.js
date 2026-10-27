import crypto from 'node:crypto';

// Every event leaves with an `id`, as OpenCode's wire events do: the UI drops
// a wire event without one, so an engine event without it never reached the
// session list, the live status or the unread and failed marks.
// Events built here carry no id; an `id` an adapter already set is kept.
const withEventId = (event) => (event.id ? event : { id: `evt_${crypto.randomUUID()}`, ...event });

// The server's own global message hub reads `/api/event` and treats 20
// seconds without a byte as a stalled stream (DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
// in event-stream/upstream-reader.js). It reconnects then, and an event sent
// before the new request subscribes reaches no one: a permission or question
// card the agent waits on, or the end of a turn. Half the stall timeout keeps
// a quiet session's stream attached even when timers run late.
const HEARTBEAT_MS = 10_000;

export class StreamHub {
  constructor({ heartbeatMs = HEARTBEAT_MS } = {}) {
    this.subscribers = new Map();
    this.heartbeatMs = heartbeatMs;
  }

  subscribe(sessionId, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }

    const set = this.subscribers.get(sessionId);
    set.add(res);

    res.write(': keep-alive\n\n');
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, this.heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (set.has(res)) {
        set.delete(res);
        if (set.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    };

    res.on('close', cleanup);

    return cleanup;
  }

  _sendTo(sessionId, payload) {
    const set = this.subscribers.get(sessionId);
    if (!set || set.size === 0) return;

    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
  }

  broadcast(sessionId, event, eventName = 'message') {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(withEventId(event))}\n\n`;
    this._sendTo(sessionId, payload);
    if (sessionId !== 'global') {
      this._sendTo('global', payload);
    }
  }

  closeSession(sessionId) {
    const set = this.subscribers.get(sessionId);
    if (!set) return;

    for (const res of set) {
      try {
        res.end();
      } catch {
        // Ignore
      }
    }
    this.subscribers.delete(sessionId);
  }
}

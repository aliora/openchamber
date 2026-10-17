import crypto from 'node:crypto';

// Every event leaves with an `id`, as OpenCode's wire events do: the UI drops
// a wire event without one, so an engine event without it never reached the
// session list, the live status or the unread and failed marks.
// Events built here carry no id; an `id` an adapter already set is kept.
const withEventId = (event) => (event.id ? event : { id: `evt_${crypto.randomUUID()}`, ...event });

export class StreamHub {
  constructor() {
    this.subscribers = new Map();
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

    const cleanup = () => {
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

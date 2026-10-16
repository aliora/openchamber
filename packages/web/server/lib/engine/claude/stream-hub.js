export class StreamHub {
  constructor() {
    this.subscribers = new Map();
  }

  subscribe(sessionId, res) {
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }

    const set = this.subscribers.get(sessionId);
    set.add(res);

    if (typeof res.write === 'function') {
      res.write(': keep-alive\n\n');
    }

    const cleanup = () => {
      if (set.has(res)) {
        set.delete(res);
        if (set.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    };

    if (typeof res.on === 'function') {
      res.on('close', cleanup);
    }

    return cleanup;
  }

  _sendTo(sessionId, payload) {
    const set = this.subscribers.get(sessionId);
    if (!set || set.size === 0) return;

    for (const res of set) {
      try {
        if (typeof res.write === 'function') {
          res.write(payload);
        }
      } catch {
        set.delete(res);
      }
    }
  }

  broadcast(sessionId, event, eventName = 'message') {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
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
        if (typeof res.end === 'function') {
          res.end();
        }
      } catch {
        // Ignore
      }
    }
    this.subscribers.delete(sessionId);
  }
}

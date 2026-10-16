export class ControlBridge {
  constructor() {
    this.pending = new Map();
    this.listeners = new Set();
  }

  /**
   * Calls `listener(sessionId)` after a session's pending requests change: a
   * request starts waiting, is answered, times out or is dropped with its
   * session. Returns the unsubscribe function.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(sessionId) {
    for (const listener of this.listeners) {
      listener(sessionId);
    }
  }

  async handleControlRequest(sessionId, request, permissionMode = 'manual', timeoutMs = 120000) {
    if (permissionMode === 'bypass' || permissionMode === 'bypassPermissions') {
      return { behavior: 'allow' };
    }

    if (permissionMode === 'dontAsk') {
      return { behavior: 'deny' };
    }

    const requestId = request.requestId;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve({ behavior: 'deny', reason: 'timeout' });
          this.notify(sessionId);
        }
      }, timeoutMs);

      this.pending.set(requestId, {
        sessionId,
        requestId,
        request,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
      });
      this.notify(sessionId);
    });
  }

  resolvePendingRequest(sessionId, requestId, decision = 'allow') {
    const item = this.pending.get(requestId);
    if (!item) return false;

    if (sessionId && item.sessionId !== sessionId) {
      return false;
    }

    this.pending.delete(requestId);
    item.resolve({ behavior: decision });
    this.notify(item.sessionId);
    return true;
  }

  getPendingRequests(sessionId) {
    const list = [];
    for (const item of this.pending.values()) {
      if (!sessionId || item.sessionId === sessionId) {
        list.push({
          requestId: item.requestId,
          sessionId: item.sessionId,
          toolName: item.request?.toolName,
          summary: item.request?.summary,
          input: item.request?.input,
        });
      }
    }
    return list;
  }

  clearSession(sessionId) {
    let cleared = false;
    for (const [reqId, item] of this.pending.entries()) {
      if (item.sessionId === sessionId) {
        this.pending.delete(reqId);
        item.resolve({ behavior: 'deny', reason: 'session_closed' });
        cleared = true;
      }
    }
    if (cleared) this.notify(sessionId);
  }
}

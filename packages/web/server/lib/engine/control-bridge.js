export class ControlBridge {
  constructor() {
    this.pending = new Map();
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
    for (const [reqId, item] of this.pending.entries()) {
      if (item.sessionId === sessionId) {
        this.pending.delete(reqId);
        item.resolve({ behavior: 'deny', reason: 'session_closed' });
      }
    }
  }
}

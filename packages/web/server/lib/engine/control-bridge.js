export class ControlBridge {
  constructor() {
    this.pending = new Map();
    this.questions = new Map();
    this.allowedSessions = new Set();
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
    if (permissionMode === 'bypass' || permissionMode === 'bypassPermissions' || this.allowedSessions.has(sessionId)) {
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

  askQuestion(sessionId, form) {
    return new Promise((resolve) => {
      this.questions.set(form.id, { sessionId, form, resolve });
      this.notify(sessionId);
    });
  }

  answerQuestion(sessionId, formId, answer) {
    const item = this.questions.get(formId);
    if (!item || item.sessionId !== sessionId) return false;
    this.questions.delete(formId);
    item.resolve(answer);
    this.notify(sessionId);
    return true;
  }

  getPendingQuestions(sessionId) {
    return [...this.questions.values()]
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .map((item) => item.form);
  }

  isSessionAllowed(sessionId) {
    return this.allowedSessions.has(sessionId);
  }

  allowSession(sessionId) {
    this.allowedSessions.add(sessionId);
    const answered = [];
    for (const [requestId, item] of this.pending.entries()) {
      if (item.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      item.resolve({ behavior: 'allow' });
      answered.push(requestId);
    }
    if (answered.length > 0) this.notify(sessionId);
    return answered;
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

  forgetSession(sessionId) {
    this.allowedSessions.delete(sessionId);
    this.clearSession(sessionId);
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
    for (const [formId, item] of this.questions.entries()) {
      if (item.sessionId === sessionId) {
        this.questions.delete(formId);
        item.resolve(null);
        cleared = true;
      }
    }
    if (cleared) this.notify(sessionId);
  }
}

export const createFakeConnection = (handlers = {}) => {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    async send(method, params = {}, sessionId = null) {
      calls.push({ method, params, sessionId });
      const handler = handlers[method];
      return handler ? handler(params) : {};
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method).delete(handler);
    },
    emit(method, params, sessionId = 's1') {
      for (const handler of [...(listeners.get(method) ?? [])]) handler(params, sessionId);
    },
    callsTo: (method) => calls.filter((call) => call.method === method),
  };
};

export const pageHandlers = (overrides = {}) => ({
  'Browser.getVersion': () => ({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0.0.1 Safari/537.36' }),
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
  'Page.navigate': () => ({ frameId: 'main' }),
  'Runtime.evaluate': () => ({ result: { value: 'Title' } }),
  'Page.captureScreenshot': () => ({ data: 'PNGDATA' }),
  ...overrides,
});

import { HeadlessBrowserError, isValidTabId } from './manager.js';

const COMMAND_BODY_LIMIT = '256kb';
const INPUT_BODY_LIMIT = '16kb';
const STREAM_KEEPALIVE_MS = 15_000;

const respondError = (res, error) => {
  const status = error instanceof HeadlessBrowserError ? error.status : 500;
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
};

const runCommand = async (tab, body) => {
  switch (body.command) {
    case 'navigate':
      if (typeof body.url !== 'string' || !body.url) throw new HeadlessBrowserError('url is required', 400);
      return tab.navigate(body.url, { timeoutMs: Number(body.timeoutMs) || undefined });
    case 'evaluate':
      if (typeof body.script !== 'string' || !body.script) throw new HeadlessBrowserError('script is required', 400);
      return { value: await tab.evaluate(body.script) };
    case 'click':
      if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) throw new HeadlessBrowserError('x and y are required', 400);
      await tab.click(body.x, body.y);
      return { ok: true };
    case 'type':
      if (typeof body.text !== 'string') throw new HeadlessBrowserError('text is required', 400);
      await tab.typeText(body.text, { submit: body.submit === true });
      return { ok: true };
    case 'settle':
      return { settled: await tab.settle(Number(body.timeoutMs) || undefined) };
    case 'capture':
      return tab.capture();
    case 'history':
      return tab.history(body.direction === 'forward' ? 1 : -1);
    case 'reload':
      await tab.reload();
      return tab.info();
    case 'viewport':
      return { viewport: await tab.setViewport(body.fill === true ? { kind: 'fill' } : { kind: 'fixed', width: body.width, height: body.height }) };
    case 'fit':
      await tab.fit(body.width, body.height);
      return { viewport: tab.viewportSummary() };
    case 'info':
      return { ...tab.info(), problems: tab.consoleProblems(), viewport: tab.viewportSummary() };
    default:
      throw new HeadlessBrowserError('Unknown command', 400);
  }
};

export function registerHeadlessBrowserRoutes(app, { express, manager }) {
  const withTabId = (handler) => async (req, res) => {
    if (!isValidTabId(req.params.id)) {
      res.status(400).json({ error: 'tab id is invalid' });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) respondError(res, error);
    }
  };

  app.get('/api/headless-browser/status', (_req, res) => {
    res.json(manager.status());
  });

  app.post('/api/headless-browser/tabs/:id/command', express.json({ limit: COMMAND_BODY_LIMIT }), withTabId(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const tab = await manager.tab(req.params.id);
    res.json(await runCommand(tab, body));
  }));

  app.post('/api/headless-browser/tabs/:id/input', express.json({ limit: INPUT_BODY_LIMIT }), withTabId(async (req, res) => {
    const tab = manager.existingTab(req.params.id);
    if (!tab) throw new HeadlessBrowserError('This tab is not open on the server', 404);
    await tab.input(req.body);
    res.json({ ok: true });
  }));

  app.delete('/api/headless-browser/tabs/:id', withTabId(async (req, res) => {
    res.json({ closed: await manager.closeTab(req.params.id) });
  }));

  app.get('/api/headless-browser/tabs/:id/stream', withTabId(async (req, res) => {
    const tab = await manager.tab(req.params.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (message) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    const keepalive = setInterval(() => {
      manager.existingTab(req.params.id);
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, STREAM_KEEPALIVE_MS);
    let unsubscribe = null;
    let disconnected = false;
    req.on('close', () => {
      disconnected = true;
      clearInterval(keepalive);
      void unsubscribe?.();
    });
    unsubscribe = await tab.subscribe((message) => {
      write(message);
      if (message.type === 'closed') res.end();
    });
    if (disconnected) void unsubscribe();
  }));
}

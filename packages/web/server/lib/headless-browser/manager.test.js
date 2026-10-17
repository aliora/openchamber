import { describe, expect, it } from 'vitest';
import { createHeadlessBrowserManager, HeadlessBrowserError, isValidTabId } from './manager.js';

const fakeTab = (targetId) => ({
  targetId,
  subscriberCount: 0,
  closed: false,
  markClosed() { this.closed = true; },
  async close() { this.closed = true; },
});

const setup = (options = {}) => {
  const launches = [];
  const timers = [];
  const exitHandlers = [];
  let targetCounter = 0;
  const browser = {
    stopped: false,
    killed: false,
    exited: new Promise(() => undefined),
    connection: {
      handlers: new Map(),
      async send(method) {
        if (method === 'Target.createTarget') { targetCounter += 1; return { targetId: `target-${targetCounter}` }; }
        if (method === 'Target.attachToTarget') return { sessionId: `session-${targetCounter}` };
        return {};
      },
      on(method, handler) { this.handlers.set(method, handler); },
    },
    kill() { this.killed = true; },
    async stop() { this.stopped = true; },
  };
  const manager = createHeadlessBrowserManager({
    dataDir: '/data',
    resolveChromePath: options.resolveChromePath ?? (() => ({ path: '/chrome', source: 'system' })),
    launchBrowser: async (args) => { launches.push(args); return browser; },
    createTab: async ({ targetId, onClosed }) => {
      const tab = fakeTab(targetId);
      tab.markClosed = () => { tab.closed = true; onClosed(); };
      return tab;
    },
    maxTabs: options.maxTabs ?? 3,
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    onProcessExit: (handler) => exitHandlers.push(handler),
  });
  return { manager, launches, timers, browser, exitHandlers };
};

describe('headless browser manager', () => {
  it('validates tab ids', () => {
    expect(isValidTabId('hb-0123abcd')).toBe(true);
    expect(isValidTabId('../x')).toBe(false);
    expect(isValidTabId('')).toBe(false);
    expect(isValidTabId('a'.repeat(129))).toBe(false);
  });

  it('starts the browser only when the first tab is needed, with a profile under the data dir', async () => {
    const { manager, launches } = setup();
    expect(manager.status()).toMatchObject({ available: true, running: false });
    await manager.tab('hb-1');
    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual({ chromePath: '/chrome', profileDir: '/data/headless-browser/profile' });
    expect(manager.status()).toMatchObject({ running: true, tabs: 1 });
  });

  it('shares one browser and one tab between simultaneous requests', async () => {
    const { manager, launches } = setup();
    const [a, b, c] = await Promise.all([manager.tab('hb-1'), manager.tab('hb-1'), manager.tab('hb-2')]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(launches).toHaveLength(1);
  });

  it('explains how to fix a server with no browser', async () => {
    const { manager } = setup({ resolveChromePath: () => null });
    expect(manager.status()).toMatchObject({ available: false });
    await expect(manager.tab('hb-1')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('OPENCHAMBER_CHROME_PATH') });
  });

  it('rejects a bad tab id before launching anything', async () => {
    const { manager, launches } = setup();
    await expect(manager.tab('a/b')).rejects.toBeInstanceOf(HeadlessBrowserError);
    expect(launches).toHaveLength(0);
  });

  it('closes the least recently used tab nobody is watching when the limit is reached', async () => {
    const { manager } = setup({ maxTabs: 2 });
    const first = await manager.tab('hb-1');
    await manager.tab('hb-2');
    await new Promise((resolve) => setTimeout(resolve, 2));
    manager.existingTab('hb-1');
    await manager.tab('hb-3');
    expect(manager.existingTab('hb-2')).toBeNull();
    expect(first.closed).toBe(false);
  });

  it('refuses a new tab when every tab is on screen', async () => {
    const { manager } = setup({ maxTabs: 1 });
    const only = await manager.tab('hb-1');
    only.subscriberCount = 1;
    await expect(manager.tab('hb-2')).rejects.toMatchObject({ status: 409 });
  });

  it('stops the browser after it sat idle, but not while someone watches', async () => {
    const { manager, timers, browser } = setup();
    const tab = await manager.tab('hb-1');
    tab.subscriberCount = 1;
    timers.at(-1).fn();
    expect(browser.stopped).toBe(false);
    tab.subscriberCount = 0;
    timers.at(-1).fn();
    await Promise.resolve();
    expect(browser.stopped).toBe(true);
    expect(tab.closed).toBe(true);
    expect(manager.status().running).toBe(false);
  });

  it('forgets a tab whose page was closed in the browser', async () => {
    const { manager, browser } = setup();
    const tab = await manager.tab('hb-1');
    browser.connection.handlers.get('Target.targetDestroyed')({ targetId: tab.targetId });
    expect(manager.existingTab('hb-1')).toBeNull();
    expect(tab.closed).toBe(true);
  });

  it('kills the browser when the server exits', async () => {
    const { manager, browser, exitHandlers } = setup();
    await manager.tab('hb-1');
    exitHandlers[0]();
    expect(browser.killed).toBe(true);
  });

  it('closes one tab on request', async () => {
    const { manager } = setup();
    const tab = await manager.tab('hb-1');
    expect(await manager.closeTab('hb-1')).toBe(true);
    expect(await manager.closeTab('hb-1')).toBe(false);
    expect(tab.closed).toBe(true);
  });
});

import path from 'path';
import { launchBrowser as defaultLaunchBrowser } from './browser-process.js';
import { CHROME_NOT_FOUND_MESSAGE, resolveChromePath as defaultResolveChromePath } from './chrome-path.js';
import { createHeadlessTab } from './headless-tab.js';

export const HEADLESS_IDLE_MS = 10 * 60_000;
export const HEADLESS_MAX_TABS = 8;
const TAB_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;

export class HeadlessBrowserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HeadlessBrowserError';
    this.status = status;
  }
}

export const isValidTabId = (value) => typeof value === 'string' && TAB_ID_PATTERN.test(value);

export const createHeadlessBrowserManager = ({
  dataDir,
  resolveChromePath = defaultResolveChromePath,
  launchBrowser = defaultLaunchBrowser,
  createTab = createHeadlessTab,
  idleMs = HEADLESS_IDLE_MS,
  maxTabs = HEADLESS_MAX_TABS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => undefined,
  onProcessExit = (handler) => process.once('exit', handler),
}) => {
  const profileDir = path.join(dataDir, 'headless-browser', 'profile');
  const tabs = new Map();
  const lastUsed = new Map();
  const creating = new Map();
  let browser = null;
  let launching = null;
  let idleTimer = null;

  onProcessExit(() => browser?.kill());

  const chrome = () => resolveChromePath();

  const stopBrowser = async () => {
    const current = browser;
    browser = null;
    for (const tab of tabs.values()) tab.markClosed();
    tabs.clear();
    if (current) await current.stop().catch(() => undefined);
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      const watched = [...tabs.values()].some((tab) => tab.subscriberCount > 0);
      if (watched) {
        armIdleTimer();
        return;
      }
      log('stopping the idle headless browser');
      void stopBrowser();
    }, idleMs);
    idleTimer.unref?.();
  };

  const ensureBrowser = async () => {
    if (browser) return browser;
    if (launching) return launching;
    const found = chrome();
    if (!found) throw new HeadlessBrowserError(CHROME_NOT_FOUND_MESSAGE, 503);
    launching = launchBrowser({ chromePath: found.path, profileDir })
      .then((started) => {
        browser = started;
        started.exited.then(() => {
          if (browser !== started) return;
          browser = null;
          for (const tab of tabs.values()) tab.markClosed();
          tabs.clear();
        });
        started.connection.on('Target.targetDestroyed', ({ targetId }) => {
          for (const [id, tab] of tabs) {
            if (tab.targetId !== targetId) continue;
            tabs.delete(id);
            tab.markClosed();
          }
        });
        return started;
      })
      .catch((error) => {
        throw new HeadlessBrowserError(error instanceof Error ? error.message : String(error), 503);
      })
      .finally(() => {
        launching = null;
      });
    return launching;
  };

  const evictOldestUnwatched = async () => {
    const candidates = [...tabs.entries()]
      .filter(([, tab]) => tab.subscriberCount === 0)
      .sort(([a], [b]) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
    if (candidates.length === 0) {
      throw new HeadlessBrowserError(`The server browser already has ${maxTabs} tabs open and all of them are on screen. Close one before opening another.`, 409);
    }
    await manager.closeTab(candidates[0][0]);
  };

  const openTab = async (id) => {
    if (tabs.size >= maxTabs) await evictOldestUnwatched();
    const started = await ensureBrowser();
    const { targetId } = await started.connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await started.connection.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = await createTab({
      connection: started.connection,
      targetId,
      sessionId,
      onClosed: () => {
        if (tabs.get(id)?.targetId === targetId) tabs.delete(id);
      },
    });
    tabs.set(id, tab);
    return tab;
  };

  const touch = (id) => {
    lastUsed.set(id, Date.now());
    armIdleTimer();
  };

  const manager = {
    status() {
      const found = chrome();
      return found
        ? { available: true, source: found.source, tabs: tabs.size, running: browser !== null }
        : { available: false, reason: CHROME_NOT_FOUND_MESSAGE, tabs: 0, running: false };
    },

    async tab(id) {
      if (!isValidTabId(id)) throw new HeadlessBrowserError('tab id is invalid', 400);
      touch(id);
      const existing = tabs.get(id);
      if (existing) return existing;
      const inFlight = creating.get(id);
      if (inFlight) return inFlight;
      const pending = openTab(id).finally(() => creating.delete(id));
      creating.set(id, pending);
      return pending;
    },

    existingTab(id) {
      touch(id);
      return tabs.get(id) ?? null;
    },

    async closeTab(id) {
      const tab = tabs.get(id);
      if (!tab) return false;
      tabs.delete(id);
      lastUsed.delete(id);
      await tab.close();
      return true;
    },

    async shutdown() {
      if (idleTimer) clearTimer(idleTimer);
      idleTimer = null;
      await stopBrowser();
    },
  };

  return manager;
};

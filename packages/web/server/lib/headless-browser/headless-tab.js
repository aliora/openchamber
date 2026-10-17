import { toCdpInput } from './input-bridge.js';
import { buildUserAgentOverride } from './user-agent.js';

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MIN_SIZE = 240;
const MAX_SIZE = 3840;
const SETTLE_QUIET_MS = 150;
const SETTLE_DEFAULT_MS = 15_000;
const CONSOLE_PROBLEM_LIMIT = 20;
const SCREENCAST_QUALITY = 60;
const MOBILE_WIDTH_LIMIT = 500;
const KEYSTROKE_INTERVAL_MS = 10;
const MAX_KEYSTROKE_CHARS = 400;
const HOVER_OFFSET_PX = 24;

const ENTER_KEY_DOWN = Object.freeze({ kind: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 });

const POPUP_GUARD_SCRIPT = `
(() => {
  const own = (url) => { if (url) window.location.href = String(url); return null; };
  window.open = own;
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[target]') : null;
    if (anchor && anchor.target === '_blank') anchor.target = '_self';
  }, true);
})();
`;

const clampSize = (value) => Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, Number(value) || MIN_SIZE)));

export const createHeadlessTab = async ({ connection, targetId, sessionId, onClosed }) => {
  const send = (method, params) => connection.send(method, params, sessionId);
  const subscribers = new Set();
  const problems = [];
  const unsubscribers = [];
  let mainFrameId = null;
  let loading = false;
  let lastLoadActivity = Date.now();
  let url = 'about:blank';
  let title = '';
  let closed = false;
  let viewport = { kind: 'fill' };
  let fillSize = { ...DEFAULT_VIEWPORT };
  let screencastRunning = false;
  let lastFrame = null;
  const loadWaiters = new Set();

  const effectiveSize = () => (viewport.kind === 'fill' ? fillSize : { width: viewport.width, height: viewport.height });

  const notify = (message) => {
    for (const subscriber of subscribers) subscriber(message);
  };

  const publishMeta = () => notify({ type: 'meta', url, title, loading });

  const listen = (method, handler) => {
    unsubscribers.push(connection.on(method, (params, eventSession) => {
      if (eventSession === sessionId) handler(params);
    }));
  };

  const setLoading = (value) => {
    loading = value;
    lastLoadActivity = Date.now();
    if (!value) for (const wake of [...loadWaiters]) wake();
    publishMeta();
  };

  const pushProblem = (level, message, source = '') => {
    problems.push({ level, message: String(message).slice(0, 400), source });
    if (problems.length > CONSOLE_PROBLEM_LIMIT) problems.splice(0, problems.length - CONSOLE_PROBLEM_LIMIT);
  };

  const refreshTitle = async () => {
    try {
      const result = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const next = typeof result.result?.value === 'string' ? result.result.value : '';
      if (next !== title) {
        title = next;
        publishMeta();
      }
    } catch {
      return;
    }
  };

  listen('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId) return;
    mainFrameId = frame.id;
    url = frame.url;
    problems.length = 0;
    publishMeta();
  });
  listen('Page.navigatedWithinDocument', ({ frameId, url: next }) => {
    if (frameId !== mainFrameId) return;
    url = next;
    publishMeta();
  });
  listen('Page.frameStartedLoading', ({ frameId }) => {
    if (mainFrameId && frameId !== mainFrameId) return;
    setLoading(true);
  });
  listen('Page.frameStoppedLoading', ({ frameId }) => {
    if (mainFrameId && frameId !== mainFrameId) return;
    setLoading(false);
    void refreshTitle();
  });
  listen('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error' && type !== 'warning') return;
    pushProblem(type === 'error' ? 'error' : 'warning', (args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });
  listen('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    pushProblem('error', exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'Uncaught exception', exceptionDetails?.url ?? '');
  });
  listen('Page.javascriptDialogOpening', ({ type, message }) => {
    pushProblem('warning', `The page opened a ${type} dialog: ${message}`);
    void send('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }).catch(() => undefined);
  });
  listen('Page.screencastFrame', ({ data, metadata, sessionId: frameSession }) => {
    void send('Page.screencastFrameAck', { sessionId: frameSession }).catch(() => undefined);
    lastFrame = { type: 'frame', data, width: metadata.deviceWidth, height: metadata.deviceHeight };
    notify(lastFrame);
  });
  listen('Inspector.targetCrashed', () => {
    pushProblem('error', 'The page crashed');
    notify({ type: 'crashed' });
  });

  const applyViewport = async () => {
    const { width, height } = effectiveSize();
    const mobile = viewport.kind !== 'fill' && width <= MOBILE_WIDTH_LIMIT;
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    if (screencastRunning) await restartScreencast();
  };

  let screencastQueue = Promise.resolve();

  const restartScreencast = () => {
    const run = async () => {
      const { width, height } = effectiveSize();
      await send('Page.stopScreencast').catch(() => undefined);
      await send('Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    };
    const result = screencastQueue.then(run);
    screencastQueue = result.catch(() => undefined);
    return result;
  };

  const startScreencast = async () => {
    if (screencastRunning) return;
    screencastRunning = true;
    await restartScreencast();
  };

  const stopScreencast = async () => {
    if (!screencastRunning) return;
    screencastRunning = false;
    await screencastQueue;
    await send('Page.stopScreencast').catch(() => undefined);
  };

  const settle = async (timeoutMs = SETTLE_DEFAULT_MS) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      if (loading) {
        const done = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            loadWaiters.delete(wake);
            resolve(false);
          }, remaining);
          const wake = () => {
            clearTimeout(timer);
            loadWaiters.delete(wake);
            resolve(true);
          };
          loadWaiters.add(wake);
        });
        if (!done) return false;
        continue;
      }
      const quiet = SETTLE_QUIET_MS - (Date.now() - lastLoadActivity);
      if (quiet <= 0) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(quiet, remaining)));
    }
  };

  const cleanupAndClose = () => {
    if (closed) return;
    closed = true;
    for (const stop of unsubscribers) stop();
    for (const wake of [...loadWaiters]) wake();
    notify({ type: 'closed' });
    subscribers.clear();
    onClosed?.();
  };

  const userAgentOverride = buildUserAgentOverride(await send('Browser.getVersion').catch(() => ({})));
  await Promise.all([
    send('Page.enable'),
    send('Runtime.enable'),
    send('Page.addScriptToEvaluateOnNewDocument', { source: POPUP_GUARD_SCRIPT }),
    userAgentOverride ? send('Emulation.setUserAgentOverride', userAgentOverride) : Promise.resolve(),
  ]);
  const tree = await send('Page.getFrameTree');
  mainFrameId = tree.frameTree.frame.id;
  await applyViewport();

  return {
    targetId,
    get url() { return url; },
    get title() { return title; },
    get loading() { return loading; },
    get lastFrame() { return lastFrame; },
    get subscriberCount() { return subscribers.size; },
    info: () => ({ url, title, loading }),
    consoleProblems: () => problems.map((entry) => ({ ...entry })),
    settle,

    async navigate(target, { timeoutMs = SETTLE_DEFAULT_MS } = {}) {
      const result = await send('Page.navigate', { url: target });
      if (result.errorText) throw new Error(`The page could not be loaded: ${result.errorText}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = await settle(timeoutMs);
      await refreshTitle();
      return { url, title, settled };
    },

    async history(delta) {
      const { currentIndex, entries } = await send('Page.getNavigationHistory');
      const entry = entries[currentIndex + delta];
      if (!entry) throw new Error(delta < 0 ? 'There is no earlier page in this tab' : 'There is no later page in this tab');
      await send('Page.navigateToHistoryEntry', { entryId: entry.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settle();
      await refreshTitle();
      return { url, title };
    },

    async reload() {
      await send('Page.reload');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settle();
    },

    async evaluate(script) {
      const result = await send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The page script failed');
      }
      return result.result?.value ?? null;
    },

    async capture() {
      const { width, height } = effectiveSize();
      const result = await send('Page.captureScreenshot', { format: 'png' });
      return { base64: result.data, mime: 'image/png', width, height, url, title };
    },

    async setViewport(next) {
      viewport = next.kind === 'fill'
        ? { kind: 'fill' }
        : { kind: 'fixed', width: clampSize(next.width), height: clampSize(next.height) };
      await applyViewport();
      return this.viewportSummary();
    },

    viewportSummary() {
      if (viewport.kind === 'fill') return { mode: 'fill', width: fillSize.width, height: fillSize.height };
      return { mode: 'custom', width: viewport.width, height: viewport.height };
    },

    async fit(width, height) {
      const next = { width: clampSize(width), height: clampSize(height) };
      if (next.width === fillSize.width && next.height === fillSize.height) return;
      fillSize = next;
      if (viewport.kind === 'fill') await applyViewport();
    },

    async input(event) {
      const command = toCdpInput(event);
      if (!command) throw new Error('Unsupported input event');
      await send(command.method, command.params);
    },

    async click(x, y) {
      await this.input({ kind: 'mouse', type: 'move', x: Math.max(0, x - HOVER_OFFSET_PX), y: Math.max(0, y - HOVER_OFFSET_PX) });
      await this.input({ kind: 'mouse', type: 'move', x, y });
      await this.input({ kind: 'mouse', type: 'down', x, y, button: 'left', clickCount: 1 });
      await this.input({ kind: 'mouse', type: 'up', x, y, button: 'left', clickCount: 1 });
    },

    async typeText(text, { submit = false } = {}) {
      if (text.length > MAX_KEYSTROKE_CHARS) {
        await this.input({ kind: 'text', text });
      } else if (text === '') {
        await this.pressKey('Backspace', 8);
      } else {
        for (const character of text) {
          await this.input(character === '\n' ? ENTER_KEY_DOWN : { kind: 'key', type: 'down', key: character, code: '', keyCode: 0, modifiers: 0 });
          await this.input({ kind: 'key', type: 'up', key: character === '\n' ? 'Enter' : character, code: '', keyCode: 0, modifiers: 0 });
          await new Promise((resolve) => setTimeout(resolve, KEYSTROKE_INTERVAL_MS));
        }
      }
      if (submit) await this.pressKey('Enter', 13);
    },

    async pressKey(key, keyCode) {
      await this.input({ kind: 'key', type: 'down', key, code: key, keyCode, modifiers: 0 });
      await this.input({ kind: 'key', type: 'up', key, code: key, keyCode, modifiers: 0 });
    },

    async subscribe(listener) {
      subscribers.add(listener);
      listener({ type: 'meta', url, title, loading });
      if (lastFrame) listener(lastFrame);
      await startScreencast();
      return async () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) await stopScreencast();
      };
    },

    async close() {
      if (closed) return;
      await connection.send('Target.closeTarget', { targetId }).catch(() => undefined);
      cleanupAndClose();
    },

    markClosed: cleanupAndClose,
  };
};

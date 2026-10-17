import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type Listener = (event: {
  type: string;
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
  context: { directory: string | null; sessionId: string | null };
}) => void;

const posted: Array<{ requestId: string; ok: boolean; data?: Record<string, unknown>; error?: string }> = [];
let listener: Listener | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (path.endsWith('/claim')) return { ok: true, status: 200, json: async () => ({ granted: true }) };
    posted.push(body);
    return { ok: true, status: 200 };
  }),
}));
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (handler: Listener) => {
    listener = handler;
    return () => { listener = null; };
  },
}));

const { registerBrowserController, registerBrowserOpener, setShownBrowserTab } = await import('./controlClient');
const { canDriveBrowserPage, setHeadlessBrowserAvailable, usesServerBrowser } = await import('./hostCapability');
const { createHeadlessActionRunner } = await import('./headlessActions');
const { FILL_VIEWPORT } = await import('./viewport');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => void> = [];

describe('a web client with a server browser', () => {
  beforeEach(() => {
    posted.length = 0;
    setHeadlessBrowserAvailable(true);
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    setHeadlessBrowserAvailable(false);
  });

  test('declares that it can drive a page and uses the server browser', () => {
    expect(canDriveBrowserPage()).toBe(true);
    expect(usesServerBrowser()).toBe(true);
  });

  test('a server-browser tab answers an agent open with drivable true', async () => {
    const commands: string[] = [];
    const run = createHeadlessActionRunner({
      send: (async (command: { command: string }) => {
        commands.push(command.command);
        return { url: 'https://a.test/', title: 'A', settled: true };
      }) as never,
      getViewport: () => FILL_VIEWPORT,
      setViewport: () => undefined,
    });
    cleanups.push(registerBrowserOpener(() => {
      setTimeout(() => {
        cleanups.push(registerBrowserController({
          tabId: 'tab-new',
          directory: '/repo',
          ownerSessionId: 'ses_1',
          describe: () => ({ title: '', url: '' }),
          run,
        }));
      }, 60);
      return 'tab-new';
    }));

    listener?.({ type: 'browser-control-request', requestId: 'req-1', action: 'browser.open', parameters: { url: 'https://a.test/' }, context: { directory: '/repo', sessionId: 'ses_1' } });
    await wait(300);

    expect(commands).toEqual([]);
    expect(posted[0]?.data?.drivable).toBe(true);
    expect(posted[0]?.data?.tabId).toBe('tab-new');
  });

  test('a click request reaches the server browser through the registered tab', async () => {
    const commands: string[] = [];
    const run = createHeadlessActionRunner({
      send: (async (command: { command: string }) => {
        commands.push(command.command);
        return command.command === 'evaluate' ? { value: { ok: true, clicked: 'a' } } : { url: 'https://a.test/', title: '', loading: false, problems: [] };
      }) as never,
      getViewport: () => FILL_VIEWPORT,
      setViewport: () => undefined,
      pause: async () => undefined,
    });
    setShownBrowserTab('/repo', 'tab-1');
    cleanups.push(registerBrowserController({ tabId: 'tab-1', directory: '/repo', ownerSessionId: null, describe: () => ({ title: '', url: '' }), run }));

    listener?.({ type: 'browser-control-request', requestId: 'req-2', action: 'browser.click', parameters: { text: 'Go' }, context: { directory: '/repo', sessionId: null } });
    await wait(300);

    expect(commands).toContain('evaluate');
    expect(posted[0]?.ok).toBe(true);
  });
});

describe('a web client without a server browser', () => {
  test('stays display-only', () => {
    setHeadlessBrowserAvailable(false);
    expect(canDriveBrowserPage()).toBe(false);
    expect(usesServerBrowser()).toBe(false);
  });
});

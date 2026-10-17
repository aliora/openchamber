import { describe, expect, test } from 'bun:test';

import { createHeadlessActionRunner, normalizeHeadlessAddress } from './headlessActions';
import type { HeadlessCommand } from './headlessBrowserClient';
import { FILL_VIEWPORT, type BrowserViewport } from './viewport';

type Reply = (command: HeadlessCommand) => unknown;

const setup = (reply: Reply, reveal?: () => void) => {
  const sent: HeadlessCommand[] = [];
  let viewport: BrowserViewport = FILL_VIEWPORT;
  const runner = createHeadlessActionRunner({
    send: (async (command: HeadlessCommand) => {
      sent.push(command);
      return reply(command);
    }) as never,
    getViewport: () => viewport,
    setViewport: (next) => { viewport = next; },
    pause: async () => undefined,
    reveal,
  });
  return { runner, sent, viewport: () => viewport };
};

const info = { url: 'https://after.test/', title: 'After', loading: false, problems: [] };

describe('headless action runner', () => {
  test('opens a page and reports what loaded', async () => {
    const { runner, sent } = setup(() => ({ url: 'https://a.test/', title: 'A', settled: true }));
    const result = await runner('browser.open', { url: 'https://a.test/' });
    expect(sent).toEqual([{ command: 'navigate', url: 'https://a.test/', timeoutMs: 25_000 }]);
    expect(result).toEqual({
      url: 'https://a.test/', title: 'A', opened: true, settled: true, viewport: { mode: 'fill', width: null, height: null },
    });
  });

  test('brings the tab to the front when the agent opens a page in it', async () => {
    let revealed = 0;
    const { runner } = setup(() => ({ url: 'https://a.test/', title: 'A', settled: true }), () => { revealed += 1; });
    await runner('browser.open', { url: 'https://a.test/' });
    expect(revealed).toBe(1);
  });

  test('applies the requested layout before loading the page', async () => {
    const { runner, sent } = setup(() => ({ url: 'https://a.test/', title: '', settled: true }));
    const result = await runner('browser.open', { url: 'https://a.test/', viewport: 'mobile' }) as { viewport: unknown };
    expect(sent[0]).toEqual({ command: 'viewport', fill: false, width: 390, height: 844 });
    expect(sent[1]?.command).toBe('navigate');
    expect(result.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
  });

  test('resizes to fill with a fill command', async () => {
    const { runner, sent } = setup(() => ({}));
    await runner('browser.resize', { viewport: 'tablet' });
    await runner('browser.resize', { viewport: 'fill' });
    expect(sent.map((command) => command.command)).toEqual(['viewport', 'viewport']);
    expect(sent[1]).toEqual({ command: 'viewport', fill: true });
  });

  test('rejects a resize without a known layout', async () => {
    const { runner } = setup(() => ({}));
    await expect(runner('browser.resize', { viewport: 'huge' })).rejects.toThrow('viewport is required');
  });

  test('reads the page with a script and adds layout and logged problems', async () => {
    const problems = [{ level: 'error', message: 'boom', source: '' }];
    const { runner, sent } = setup((command) => (
      command.command === 'evaluate' ? { value: { ok: true, text: 'hi' } } : { ...info, problems }
    ));
    const result = await runner('browser.snapshot', {});
    expect(sent.map((command) => command.command)).toEqual(['settle', 'evaluate', 'info']);
    expect(result).toEqual({ ok: true, text: 'hi', viewport: { mode: 'fill', width: null, height: null }, consoleProblems: problems });
  });

  test('a click finds the element, clicks its centre with real input and names the page shown afterwards', async () => {
    const { runner, sent } = setup((command) => (
      command.command === 'evaluate' ? { value: { ok: true, x: 40, y: 12, clicked: 'a', url: 'https://before.test/' } } : info
    ));
    const result = await runner('browser.click', { text: 'Go' });
    expect(sent.map((command) => command.command)).toEqual(['settle', 'evaluate', 'click', 'settle', 'info']);
    expect(sent[2]).toEqual({ command: 'click', x: 40, y: 12 });
    expect(result).toEqual({ ok: true, clicked: 'a', url: 'https://after.test/' });
  });

  test('typing focuses the field and sends real keystrokes, waiting for navigation only when it submits', async () => {
    const { runner, sent } = setup((command) => (command.command === 'evaluate' ? { value: { ok: true, selector: '#q' } } : info));
    await runner('browser.type', { selector: '#q', value: 'x', submit: false });
    expect(sent.map((command) => command.command)).toEqual(['settle', 'evaluate', 'type']);
    expect(sent[2]).toEqual({ command: 'type', text: 'x', submit: false });
    sent.length = 0;
    const result = await runner('browser.type', { selector: '#q', value: 'y', submit: true });
    expect(sent.map((command) => command.command)).toEqual(['settle', 'evaluate', 'type', 'settle', 'info']);
    expect(result).toEqual({ ok: true, selector: '#q', url: 'https://after.test/' });
  });

  test('turns a failed page script into the error the agent reads', async () => {
    const { runner } = setup(() => ({ value: { ok: false, error: 'No element matches #x' } }));
    await expect(runner('browser.click', { selector: '#x' })).rejects.toThrow('No element matches #x');
  });

  test('fails when the page returns nothing', async () => {
    const { runner } = setup(() => ({ value: null }));
    await expect(runner('browser.inspect', { selector: 'a' })).rejects.toThrow('The page returned no result');
  });

  test('moves through history and takes screenshots', async () => {
    const { runner, sent } = setup((command) => (command.command === 'capture'
      ? { base64: 'AA', mime: 'image/png', width: 1, height: 1, url: 'u', title: 't' }
      : { url: 'u', title: 't' }));
    await runner('browser.back', {});
    await runner('browser.forward', {});
    const capture = await runner('browser.capture', {}) as Record<string, unknown>;
    expect(sent).toEqual([
      { command: 'history', direction: 'back' },
      { command: 'history', direction: 'forward' },
      { command: 'capture' },
    ]);
    expect(capture.base64).toBe('AA');
    expect(capture.viewport).toEqual({ mode: 'fill', width: null, height: null });
  });

  test('refuses an action it does not know', async () => {
    const { runner } = setup(() => ({}));
    await expect(runner('browser.teleport', {})).rejects.toThrow('Unsupported browser action: browser.teleport');
  });
});

describe('address bar', () => {
  test('keeps file addresses and normalizes the rest', () => {
    expect(normalizeHeadlessAddress('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    expect(normalizeHeadlessAddress('example.com')).toBe('https://example.com/');
    expect(normalizeHeadlessAddress('localhost:5173')).toBe('http://localhost:5173/');
  });
});

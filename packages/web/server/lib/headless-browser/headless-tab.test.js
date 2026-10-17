import { describe, expect, it } from 'vitest';
import { createFakeConnection, pageHandlers } from './fake-connection.js';
import { createHeadlessTab } from './headless-tab.js';

const open = async (overrides) => {
  const connection = createFakeConnection(pageHandlers(overrides));
  let closed = 0;
  const tab = await createHeadlessTab({ connection, targetId: 't1', sessionId: 's1', onClosed: () => { closed += 1; } });
  return { connection, tab, closedCount: () => closed };
};

const navigated = (connection, url) => connection.emit('Page.frameNavigated', { frame: { id: 'main', url } });

describe('createHeadlessTab', () => {
  it('prepares the page, hides the headless marker and starts at desktop size', async () => {
    const { connection } = await open();
    expect(connection.callsTo('Emulation.setUserAgentOverride')[0].params.userAgent).toBe('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.1 Safari/537.36');
    expect(connection.callsTo('Emulation.setDeviceMetricsOverride')[0].params).toMatchObject({ width: 1280, height: 800, mobile: false });
    expect(connection.callsTo('Page.addScriptToEvaluateOnNewDocument')[0].params.source).toContain('window.open');
  });

  it('navigates, waits for the load to end and reads the title', async () => {
    const { connection, tab } = await open({
      'Page.navigate': () => {
        queueMicrotask(() => {
          navigated(connection, 'https://a.test/');
          connection.emit('Page.frameStartedLoading', { frameId: 'main' });
          setTimeout(() => connection.emit('Page.frameStoppedLoading', { frameId: 'main' }), 20);
        });
        return { frameId: 'main' };
      },
    });
    expect(await tab.navigate('https://a.test/')).toEqual({ url: 'https://a.test/', title: 'Title', settled: true });
  });

  it('turns a failed load into an error the agent can read', async () => {
    const { tab } = await open({ 'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) });
    await expect(tab.navigate('https://nope.invalid/')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });

  it('settle gives up on a page that never finishes loading', async () => {
    const { connection, tab } = await open();
    connection.emit('Page.frameStartedLoading', { frameId: 'main' });
    expect(await tab.settle(60)).toBe(false);
  });

  it('ignores loading that happens in a child frame', async () => {
    const { connection, tab } = await open();
    connection.emit('Page.frameStartedLoading', { frameId: 'ad-frame' });
    expect(tab.loading).toBe(false);
  });

  it('evaluates in the page and surfaces a script failure', async () => {
    const { tab: good } = await open({ 'Runtime.evaluate': () => ({ result: { value: { ok: true } } }) });
    expect(await good.evaluate('1')).toEqual({ ok: true });
    const { tab: bad } = await open({ 'Runtime.evaluate': () => ({ exceptionDetails: { exception: { description: 'ReferenceError: x' } } }) });
    await expect(bad.evaluate('x')).rejects.toThrow('ReferenceError: x');
  });

  it('keeps only warnings and errors the page logged, and forgets them on navigation', async () => {
    const { connection, tab } = await open();
    connection.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hi' }] });
    connection.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'bad' }, { value: 'thing' }] });
    expect(tab.consoleProblems()).toEqual([{ level: 'error', message: 'bad thing', source: '' }]);
    navigated(connection, 'https://b.test/');
    expect(tab.consoleProblems()).toEqual([]);
  });

  it('dismisses page dialogs so the page cannot hang the agent', async () => {
    const { connection, tab } = await open();
    connection.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
    expect(connection.callsTo('Page.handleJavaScriptDialog')[0].params).toEqual({ accept: false });
    expect(tab.consoleProblems()[0].message).toContain('confirm dialog');
  });

  it('goes through history and says when there is nowhere to go', async () => {
    const { connection, tab } = await open({
      'Page.getNavigationHistory': () => ({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] }),
    });
    await tab.history(-1);
    expect(connection.callsTo('Page.navigateToHistoryEntry')[0].params).toEqual({ entryId: 10 });
    await expect(tab.history(1)).rejects.toThrow('no later page');
  });

  it('takes a screenshot at the laid-out size', async () => {
    const { tab } = await open();
    await tab.setViewport({ kind: 'fixed', width: 390, height: 844 });
    expect(await tab.capture()).toMatchObject({ base64: 'PNGDATA', mime: 'image/png', width: 390, height: 844 });
  });

  it('lays a narrow viewport out as a phone and clamps absurd sizes', async () => {
    const { connection, tab } = await open();
    await tab.setViewport({ kind: 'fixed', width: 390, height: 844 });
    expect(connection.callsTo('Emulation.setDeviceMetricsOverride').at(-1).params).toMatchObject({ width: 390, mobile: true });
    await tab.setViewport({ kind: 'fixed', width: 99_999, height: 1 });
    expect(connection.callsTo('Emulation.setDeviceMetricsOverride').at(-1).params).toMatchObject({ width: 3840, height: 240 });
  });

  it('follows the panel size only while the layout is fill', async () => {
    const { connection, tab } = await open();
    await tab.fit(900, 600);
    expect(connection.callsTo('Emulation.setDeviceMetricsOverride').at(-1).params).toMatchObject({ width: 900, height: 600 });
    await tab.setViewport({ kind: 'fixed', width: 390, height: 844 });
    const before = connection.callsTo('Emulation.setDeviceMetricsOverride').length;
    await tab.fit(1000, 700);
    expect(connection.callsTo('Emulation.setDeviceMetricsOverride')).toHaveLength(before);
    expect((await tab.setViewport({ kind: 'fill' }))).toEqual({ mode: 'fill', width: 1000, height: 700 });
  });

  it('streams frames to viewers, acknowledges each one and stops with the last viewer', async () => {
    const { connection, tab } = await open();
    const received = [];
    const unsubscribe = await tab.subscribe((message) => received.push(message));
    expect(connection.callsTo('Page.startScreencast')).toHaveLength(1);
    connection.emit('Page.screencastFrame', { data: 'JPEG', metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 77 });
    expect(received.at(-1)).toEqual({ type: 'frame', data: 'JPEG', width: 1280, height: 800 });
    expect(connection.callsTo('Page.screencastFrameAck')[0].params).toEqual({ sessionId: 77 });
    const late = [];
    const unsubscribeLate = await tab.subscribe((message) => late.push(message));
    expect(late.map((message) => message.type)).toEqual(['meta', 'frame']);
    expect(connection.callsTo('Page.startScreencast')).toHaveLength(1);
    const stopsBefore = connection.callsTo('Page.stopScreencast').length;
    await unsubscribe();
    expect(connection.callsTo('Page.stopScreencast')).toHaveLength(stopsBefore);
    await unsubscribeLate();
    expect(connection.callsTo('Page.stopScreencast')).toHaveLength(stopsBefore + 1);
  });

  it('keeps overlapping fits from starting a second screencast', async () => {
    let active = false;
    const lag = () => new Promise((resolve) => setTimeout(resolve, 5));
    const { tab } = await open({
      'Page.startScreencast': async () => {
        await lag();
        if (active) throw new Error('Screencast is already active');
        active = true;
        return {};
      },
      'Page.stopScreencast': async () => {
        await lag();
        active = false;
        return {};
      },
    });
    await tab.subscribe(() => undefined);
    await Promise.all([tab.fit(900, 600), tab.fit(1000, 700), tab.fit(1100, 800)]);
    expect(active).toBe(true);
  });

  it('forwards input and refuses what it cannot translate', async () => {
    const { connection, tab } = await open();
    await tab.input({ kind: 'mouse', type: 'down', x: 5, y: 6 });
    expect(connection.callsTo('Input.dispatchMouseEvent')[0].params).toMatchObject({ type: 'mousePressed', x: 5, y: 6 });
    await expect(tab.input({ kind: 'nope' })).rejects.toThrow('Unsupported input event');
  });

  it('clicks like a pointer: approach, press, release', async () => {
    const { connection, tab } = await open();
    await tab.click(100, 50);
    const types = connection.callsTo('Input.dispatchMouseEvent').map((call) => call.params.type);
    expect(types).toEqual(['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(connection.callsTo('Input.dispatchMouseEvent')[2].params).toMatchObject({ x: 100, y: 50, button: 'left', clickCount: 1 });
  });

  it('types a value key by key and submits with Enter', async () => {
    const { connection, tab } = await open();
    await tab.typeText('hi', { submit: true });
    const keys = connection.callsTo('Input.dispatchKeyEvent').map((call) => [call.params.type, call.params.key, call.params.text]);
    expect(keys).toEqual([
      ['keyDown', 'h', 'h'], ['keyUp', 'h', undefined],
      ['keyDown', 'i', 'i'], ['keyUp', 'i', undefined],
      ['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined],
    ]);
  });

  it('clears a field typed with an empty value and inserts long text in one go', async () => {
    const { connection, tab } = await open();
    await tab.typeText('');
    expect(connection.callsTo('Input.dispatchKeyEvent')[0].params.key).toBe('Backspace');
    await tab.typeText('x'.repeat(401));
    expect(connection.callsTo('Input.insertText')).toHaveLength(1);
  });

  it('tells viewers when it closes and runs its cleanup once', async () => {
    const { tab, closedCount } = await open();
    const received = [];
    await tab.subscribe((message) => received.push(message.type));
    await tab.close();
    await tab.close();
    expect(received.at(-1)).toBe('closed');
    expect(closedCount()).toBe(1);
  });
});

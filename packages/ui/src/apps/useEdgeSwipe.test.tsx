import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolveEdgeDragRelease, useEdgeSwipe, type DrawerDragControl } from './useEdgeSwipe';

describe('edge swipe selection isolation', () => {
  let root: Root;
  let text: HTMLParagraphElement;
  let scroller: HTMLElement;
  let cell: HTMLElement;
  let opened: string[];
  let restoreGlobals: () => void;
  let render: (enabled?: boolean, wideStartEdge?: 'left' | 'right') => Promise<void>;

  beforeEach(async () => {
    const dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    opened = [];
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const Harness = ({ enabled, wideStartEdge }: { enabled?: boolean; wideStartEdge?: 'left' | 'right' }) => {
      const ref = React.useRef<HTMLElement>(null);
      useEdgeSwipe(ref, {
        enabled,
        wideStartEdge,
        onLeftEdgeSwipe: () => opened.push('left'),
        onRightEdgeSwipe: () => opened.push('right'),
      });
      return (
        <main ref={ref}>
          <p>Selectable rendered message text</p>
          <div data-scroller style={{ overflowX: 'auto' }}><table><tbody><tr><td>Wide cell</td></tr></tbody></table></div>
        </main>
      );
    };
    render = async (enabled, wideStartEdge) => {
      await act(async () => root.render(<Harness enabled={enabled} wideStartEdge={wideStartEdge} />));
    };
    await render();
    const main = host.querySelector('main');
    const paragraph = host.querySelector('p');
    const wide = host.querySelector<HTMLElement>('[data-scroller]');
    const wideCell = host.querySelector<HTMLElement>('td');
    if (!main || !paragraph || !wide || !wideCell) throw new Error('Missing chat harness');
    Object.defineProperty(main, 'clientWidth', { value: 390 });
    Object.defineProperty(wide, 'clientWidth', { value: 390 });
    Object.defineProperty(wide, 'scrollWidth', { value: 900 });
    text = paragraph;
    scroller = wide;
    cell = wideCell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreGlobals();
  });

  const touch = (type: string, x: number, y = 100, target: HTMLElement = text) => {
    const point = { clientX: x, clientY: y };
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === 'touchstart' ? [point] : [],
      changedTouches: [point],
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };

  const selectText = () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };

  test('disabling and reopening a drawer discards pending gestures and restores selection guards', async () => {
    touch('touchstart', 20);
    await render(false);
    touch('touchend', 140);
    touch('touchstart', 20);
    touch('touchend', 140);
    expect(opened).toEqual([]);

    await render(true);
    touch('touchend', 140);
    touch('touchstart', 20);
    selectText();
    document.getSelection()?.removeAllRanges();
    touch('touchend', 140);
    expect(opened).toEqual([]);

    touch('touchstart', 20);
    touch('touchend', 140);
    expect(opened).toEqual(['left']);
  });

  test('a swipe from the outer third of the wide side opens its drawer', async () => {
    touch('touchstart', 110);
    touch('touchend', 230);
    expect(opened).toEqual([]);

    await render(true, 'left');
    touch('touchstart', 110);
    touch('touchend', 230);
    touch('touchstart', 300);
    touch('touchend', 180);
    expect(opened).toEqual(['left']);

    await render(true, 'right');
    touch('touchstart', 280);
    touch('touchend', 160);
    expect(opened).toEqual(['left', 'right']);
  });

  test('the outer third leaves horizontally scrollable content alone, even at its end', async () => {
    await render(true, 'left');
    scroller.scrollLeft = 0;
    touch('touchstart', 110, 100, cell);
    touch('touchend', 300, 100, cell);
    expect(opened).toEqual([]);
  });

  for (const side of ['left', 'right']) {
    const startX = side === 'left' ? 20 : 370;
    const endX = side === 'left' ? 140 : 250;

    test(`${side}: ordinary edge swipes still open the drawer`, () => {
      touch('touchstart', startX);
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: an existing selection blocks the entire gesture`, () => {
      selectText();
      touch('touchstart', startX);
      document.getSelection()?.removeAllRanges();
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });

    test(`${side}: selecting text during a swipe cancels it even if the selection clears`, () => {
      touch('touchstart', startX);
      selectText();
      document.getSelection()?.removeAllRanges();
      touch('touchend', endX);
      expect(opened).toEqual([]);

      touch('touchstart', startX);
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: selection start cancels before the browser creates a range`, () => {
      touch('touchstart', startX);
      const event = new Event('selectstart', { bubbles: true, cancelable: true });
      text.dispatchEvent(event);
      touch('touchend', endX);
      expect(event.defaultPrevented).toBe(false);
      expect(opened).toEqual([]);
    });

    test(`${side}: touchend checks the range even before selectionchange is delivered`, () => {
      const delayNotification = (event: Event) => event.stopImmediatePropagation();
      document.addEventListener('selectionchange', delayNotification, true);
      try {
        touch('touchstart', startX);
        selectText();
        touch('touchend', endX);
        expect(opened).toEqual([]);
      } finally {
        document.removeEventListener('selectionchange', delayNotification, true);
      }
    });

    test(`${side}: a collapsed caret does not block swiping`, () => {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(true);
      document.getSelection()?.addRange(range);
      touch('touchstart', startX);
      document.dispatchEvent(new Event('selectionchange'));
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: browser cancellation abandons the gesture`, () => {
      touch('touchstart', startX);
      touch('touchcancel', startX);
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });

    test(`${side}: wide content owns the gesture until it reaches its end`, () => {
      // Right-edge swipes pull content in from the right, left-edge ones from the left.
      const scrollable = side === 'left' ? 510 : 0;
      scroller.scrollLeft = scrollable;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: a normal swipe at the end of wide content does not open the drawer`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: a diagonal swipe at the end of wide content stays with the content`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      touch('touchstart', startX, 100, cell);
      // 120px across but 60px down: inside the normal axis tolerance, past the strict one.
      touch('touchend', endX, 160, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: at the end of wide content the strict angle bar decides`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      // 160px across: 60px down (0.375) is flat enough; 70px down (0.4375) is not.
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 170, cell);
      expect(opened).toEqual([]);
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 160, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: a long deliberate swipe at the end of wide content opens the drawer`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: right-to-left content scrolls from its own start`, () => {
      scroller.style.direction = 'rtl';
      // RTL scrollLeft runs from -510 (left end) to 0 (right end, the start).
      scroller.scrollLeft = side === 'left' ? 0 : -510;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);

      scroller.scrollLeft = side === 'left' ? -510 : 0;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: wide content that cannot scroll does not block the drawer`, () => {
      scroller.style.overflowX = 'hidden';
      scroller.scrollLeft = side === 'left' ? 510 : 0;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: vertical, short and non-edge gestures remain ignored`, () => {
      touch('touchstart', startX);
      touch('touchend', endX, 300);
      touch('touchstart', startX);
      touch('touchend', startX + 10);
      touch('touchstart', 195);
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });
  }
});

describe('edge drag release', () => {
  const width = 390;

  test('a slow release past the commit distance opens, short of it springs back', () => {
    expect(resolveEdgeDragRelease({ distance: 170, velocity: 0, width })).toBe(true);
    expect(resolveEdgeDragRelease({ distance: 120, velocity: 0, width })).toBe(false);
  });

  test('a fling toward the centre commits even when short', () => {
    expect(resolveEdgeDragRelease({ distance: 40, velocity: 0.6, width })).toBe(true);
  });

  test('a fling back toward the edge cancels even when far', () => {
    expect(resolveEdgeDragRelease({ distance: 300, velocity: -0.6, width })).toBe(false);
  });

  test('no travel never commits', () => {
    expect(resolveEdgeDragRelease({ distance: 0, velocity: 2, width })).toBe(false);
  });
});

describe('interactive edge drag', () => {
  let root: Root;
  let main: HTMLElement;
  let swiped: string[];
  let settled: boolean[];
  let followed: number[];
  let restoreGlobals: () => void;

  beforeEach(async () => {
    const dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    swiped = [];
    settled = [];
    followed = [];
    const drag: DrawerDragControl = {
      follow: (distance) => followed.push(distance),
      settle: (open) => settled.push(open),
    };
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const Harness = () => {
      const ref = React.useRef<HTMLElement>(null);
      useEdgeSwipe(ref, {
        onLeftEdgeSwipe: () => swiped.push('left'),
        onRightEdgeSwipe: () => swiped.push('right'),
        onLeftEdgeDrag: drag,
      });
      return <main ref={ref}><p>Chat</p></main>;
    };
    await act(async () => root.render(<Harness />));
    const found = host.querySelector('main');
    if (!found) throw new Error('Missing harness');
    Object.defineProperty(found, 'clientWidth', { value: 390 });
    main = found;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreGlobals();
  });

  const touch = (type: string, x: number, y = 100, time?: number) => {
    const point = { clientX: x, clientY: y };
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === 'touchend' ? [] : [point],
      changedTouches: [point],
    });
    if (time !== undefined) Object.defineProperty(event, 'timeStamp', { value: time });
    main.dispatchEvent(event);
    return event;
  };

  const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));

  test('the drawer follows a horizontal drag and the page does not scroll under it', async () => {
    touch('touchstart', 10);
    const move = touch('touchmove', 110);
    expect(move.defaultPrevented).toBe(true);
    await nextFrame();
    expect(followed).toEqual([100]);
  });

  test('releasing past the commit distance opens the drawer', () => {
    touch('touchstart', 10);
    touch('touchmove', 150);
    touch('touchmove', 250);
    touch('touchend', 250);
    expect(settled).toEqual([true]);
    expect(swiped).toEqual(['left']);
  });

  test('a vertical start leaves the gesture to the page', () => {
    touch('touchstart', 10);
    const move = touch('touchmove', 20, 160);
    touch('touchend', 200, 160);
    expect(move.defaultPrevented).toBe(false);
    expect(settled).toEqual([]);
    expect(swiped).toEqual([]);
  });

  test('a cancelled drag springs the drawer back', () => {
    touch('touchstart', 10);
    touch('touchmove', 120);
    touch('touchcancel', 120);
    expect(settled).toEqual([false]);
    expect(swiped).toEqual([]);
  });

  test('a thumb swipe that arcs at first and slows before lifting still opens the drawer', () => {
    const path: Array<[number, number]> = [
      [16, 296], [22, 291], [32, 286], [46, 282], [62, 279], [80, 277],
      [96, 276], [108, 276], [116, 276], [120, 276], [122, 276], [123, 276],
    ];
    touch('touchstart', 12, 300, 0);
    const moves = path.map(([x, y], index) => touch('touchmove', x, y, (index + 1) * 8));
    touch('touchend', 123, 276, path.length * 8 + 20);
    expect(moves.at(-1)?.defaultPrevented).toBe(true);
    expect(settled).toEqual([true]);
    expect(swiped).toEqual(['left']);
  });

  test('a short flick that decelerates before lifting still opens the drawer', () => {
    const path = [16, 22, 32, 46, 62, 80, 96, 108, 116, 120, 122, 123];
    touch('touchstart', 12, 100, 0);
    path.forEach((x, index) => touch('touchmove', x, 100, (index + 1) * 8));
    touch('touchend', 123, 100, path.length * 8 + 20);
    expect(settled).toEqual([true]);
    expect(swiped).toEqual(['left']);
  });

  test('a slow drag released short of the commit distance springs back', () => {
    touch('touchstart', 10, 100, 0);
    for (let step = 1; step <= 10; step += 1) touch('touchmove', 10 + step * 10, 100, step * 40);
    touch('touchend', 110, 100, 440);
    expect(settled).toEqual([false]);
    expect(swiped).toEqual([]);
  });

  test('an edge without drag handlers keeps the release-only swipe', () => {
    touch('touchstart', 380);
    const move = touch('touchmove', 300);
    touch('touchend', 260);
    expect(move.defaultPrevented).toBe(false);
    expect(swiped).toEqual(['right']);
  });
});

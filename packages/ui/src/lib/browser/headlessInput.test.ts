import { describe, expect, test } from 'bun:test';

import { isBrowserShortcut, keyInput, modifiersOf, mouseInput, toPagePoint, wheelInput } from './headlessInput';

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('headless input bridge', () => {
  test('maps a point on a scaled canvas back to page pixels', () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };
    const frame = { width: 1280, height: 800 };
    expect(toPagePoint(box, frame, 420, 250)).toEqual({ x: 640, y: 400 });
    expect(toPagePoint(box, frame, 100, 50)).toEqual({ x: 0, y: 0 });
  });

  test('has no point before a frame or a box exists', () => {
    expect(toPagePoint({ left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 }, 1, 1)).toBeNull();
    expect(toPagePoint({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 }, 1, 1)).toBeNull();
  });

  test('packs modifier keys into the browser bitmask', () => {
    expect(modifiersOf(NO_MODIFIERS)).toBe(0);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ ...NO_MODIFIERS, shiftKey: true })).toBe(8);
  });

  test('turns pointer buttons into named mouse events with a click count', () => {
    expect(mouseInput('down', { x: 3, y: 4 }, { ...NO_MODIFIERS, button: 2, detail: 2 })).toEqual({
      kind: 'mouse', type: 'down', x: 3, y: 4, button: 'right', clickCount: 2, modifiers: 0,
    });
    expect(mouseInput('move', { x: 1, y: 1 }, { ...NO_MODIFIERS, button: 0, detail: 0 }).kind).toBe('mouse');
  });

  test('carries wheel deltas', () => {
    expect(wheelInput({ x: 5, y: 6 }, { ...NO_MODIFIERS, deltaX: 0, deltaY: 120 })).toEqual({
      kind: 'mouse', type: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: 120, modifiers: 0,
    });
  });

  test('leaves shortcuts with ctrl or meta to the app, not the page', () => {
    expect(isBrowserShortcut({ ...NO_MODIFIERS, metaKey: true, key: 'v' })).toBe(true);
    expect(isBrowserShortcut({ ...NO_MODIFIERS, ctrlKey: true, key: 'Enter' })).toBe(false);
    expect(isBrowserShortcut({ ...NO_MODIFIERS, key: 'a' })).toBe(false);
  });

  test('forwards a key with its code and virtual key', () => {
    expect(keyInput('down', { ...NO_MODIFIERS, key: 'Enter', code: 'Enter', keyCode: 13 })).toEqual({
      kind: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0,
    });
  });
});

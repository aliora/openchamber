import { describe, expect, it } from 'vitest';
import { toCdpInput } from './input-bridge.js';

describe('toCdpInput', () => {
  it('maps a mouse press to a pressed event with a click count', () => {
    expect(toCdpInput({ kind: 'mouse', type: 'down', x: 10, y: 20, button: 'right', clickCount: 2, modifiers: 8 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20, modifiers: 8, button: 'right', clickCount: 2 },
    });
  });

  it('sends a hover without a button', () => {
    expect(toCdpInput({ kind: 'mouse', type: 'move', x: 1, y: 2 }).params).toMatchObject({ type: 'mouseMoved', button: 'none', clickCount: 0 });
  });

  it('carries wheel deltas', () => {
    expect(toCdpInput({ kind: 'mouse', type: 'wheel', x: 1, y: 2, deltaY: 100 }).params).toMatchObject({ type: 'mouseWheel', deltaX: 0, deltaY: 100 });
  });

  it('rejects coordinates that are not numbers and unknown shapes', () => {
    expect(toCdpInput({ kind: 'mouse', type: 'down', x: 'a', y: 2 })).toBeNull();
    expect(toCdpInput({ kind: 'mouse', type: 'fling', x: 1, y: 2 })).toBeNull();
    expect(toCdpInput({ kind: 'drag' })).toBeNull();
    expect(toCdpInput(null)).toBeNull();
  });

  it('types a printable key with its text', () => {
    expect(toCdpInput({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 }).params).toMatchObject({ type: 'keyDown', text: 'a', windowsVirtualKeyCode: 65 });
  });

  it('sends a control key as a raw key without text', () => {
    const { params } = toCdpInput({ kind: 'key', type: 'down', key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, modifiers: 0 });
    expect(params.type).toBe('rawKeyDown');
    expect(params.text).toBeUndefined();
  });

  it('gives Enter its carriage return so forms submit', () => {
    expect(toCdpInput({ kind: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 }).params).toMatchObject({ type: 'keyDown', text: '\r' });
  });

  it('does not type text for a key chord with ctrl', () => {
    expect(toCdpInput({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 }).params.text).toBeUndefined();
  });

  it('inserts pasted text and refuses empty or oversized text', () => {
    expect(toCdpInput({ kind: 'text', text: 'hello' })).toEqual({ method: 'Input.insertText', params: { text: 'hello' } });
    expect(toCdpInput({ kind: 'text', text: '' })).toBeNull();
    expect(toCdpInput({ kind: 'text', text: 'x'.repeat(10_001) })).toBeNull();
  });
});

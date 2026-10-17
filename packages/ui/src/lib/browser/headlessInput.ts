import type { HeadlessInputEvent } from './headlessBrowserClient';

const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;
const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;

type ModifierState = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };
type FrameSize = { width: number; height: number };
type Box = { left: number; top: number; width: number; height: number };

export const modifiersOf = (event: ModifierState): number => (
  (event.altKey ? MODIFIER_ALT : 0)
  | (event.ctrlKey ? MODIFIER_CTRL : 0)
  | (event.metaKey ? MODIFIER_META : 0)
  | (event.shiftKey ? MODIFIER_SHIFT : 0)
);

export const toPagePoint = (box: Box, frame: FrameSize, clientX: number, clientY: number): { x: number; y: number } | null => {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  return {
    x: Math.round(((clientX - box.left) / box.width) * frame.width),
    y: Math.round(((clientY - box.top) / box.height) * frame.height),
  };
};

export const mouseInput = (
  type: 'move' | 'down' | 'up',
  point: { x: number; y: number },
  event: ModifierState & { button: number; detail: number },
): HeadlessInputEvent => ({
  kind: 'mouse',
  type,
  x: point.x,
  y: point.y,
  button: MOUSE_BUTTONS[event.button] ?? 'left',
  clickCount: Math.max(1, event.detail),
  modifiers: modifiersOf(event),
});

export const wheelInput = (point: { x: number; y: number }, event: ModifierState & { deltaX: number; deltaY: number }): HeadlessInputEvent => ({
  kind: 'mouse',
  type: 'wheel',
  x: point.x,
  y: point.y,
  deltaX: event.deltaX,
  deltaY: event.deltaY,
  modifiers: modifiersOf(event),
});

export const isBrowserShortcut = (event: ModifierState & { key: string }): boolean => (
  (event.ctrlKey || event.metaKey) && event.key.length === 1
);

export const keyInput = (
  type: 'down' | 'up',
  event: ModifierState & { key: string; code: string; keyCode: number },
): HeadlessInputEvent => ({
  kind: 'key',
  type,
  key: event.key,
  code: event.code,
  keyCode: event.keyCode,
  modifiers: modifiersOf(event),
});

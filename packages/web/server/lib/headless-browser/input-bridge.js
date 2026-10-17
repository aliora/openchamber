const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' };
const BUTTONS = new Set(['none', 'left', 'middle', 'right']);
const MAX_TEXT_CHARS = 10_000;
const MAX_KEY_CHARS = 32;
const MAX_COORDINATE = 20_000;

const asCoordinate = (value) => (Number.isFinite(value) ? Math.min(Math.max(value, 0), MAX_COORDINATE) : null);
const asModifiers = (value) => (Number.isInteger(value) ? value & 15 : 0);
const asDelta = (value) => (Number.isFinite(value) ? Math.min(Math.max(value, -MAX_COORDINATE), MAX_COORDINATE) : 0);

const mouseCommand = (event) => {
  const type = MOUSE_TYPES[event.type];
  const x = asCoordinate(event.x);
  const y = asCoordinate(event.y);
  if (!type || x === null || y === null) return null;
  const button = BUTTONS.has(event.button) ? event.button : 'left';
  const params = { type, x, y, modifiers: asModifiers(event.modifiers) };
  if (type === 'mouseWheel') {
    return { method: 'Input.dispatchMouseEvent', params: { ...params, deltaX: asDelta(event.deltaX), deltaY: asDelta(event.deltaY) } };
  }
  const clickCount = type === 'mouseMoved' ? 0 : Math.min(Math.max(Number(event.clickCount) || 1, 1), 3);
  return { method: 'Input.dispatchMouseEvent', params: { ...params, button: type === 'mouseMoved' ? 'none' : button, clickCount } };
};

const keyCommand = (event) => {
  if (event.type !== 'down' && event.type !== 'up') return null;
  if (typeof event.key !== 'string' || !event.key || event.key.length > MAX_KEY_CHARS) return null;
  const printable = event.key.length === 1 && !(asModifiers(event.modifiers) & 3);
  const params = {
    type: event.type === 'up' ? 'keyUp' : printable ? 'keyDown' : 'rawKeyDown',
    key: event.key,
    code: typeof event.code === 'string' ? event.code.slice(0, MAX_KEY_CHARS) : '',
    modifiers: asModifiers(event.modifiers),
    windowsVirtualKeyCode: Number.isInteger(event.keyCode) ? event.keyCode : 0,
  };
  if (event.type === 'down' && printable) params.text = event.key;
  if (event.type === 'down' && event.key === 'Enter') {
    params.type = 'keyDown';
    params.text = '\r';
  }
  return { method: 'Input.dispatchKeyEvent', params };
};

const textCommand = (event) => (
  typeof event.text === 'string' && event.text && event.text.length <= MAX_TEXT_CHARS
    ? { method: 'Input.insertText', params: { text: event.text } }
    : null
);

export const toCdpInput = (event) => {
  if (!event || typeof event !== 'object') return null;
  if (event.kind === 'mouse') return mouseCommand(event);
  if (event.kind === 'key') return keyCommand(event);
  if (event.kind === 'text') return textCommand(event);
  return null;
};

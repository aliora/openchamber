import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { subscribeDesktopFocusHost } from './desktop';

describe('the focus-host event from the desktop shell', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  });

  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('hands the named host to the listener and ignores anything malformed', () => {
    const focused: string[] = [];
    const stop = subscribeDesktopFocusHost((hostId) => focused.push(hostId));

    window.dispatchEvent(new CustomEvent('openchamber:focus-host', { detail: { hostId: ' host-pi5 ' } }));
    window.dispatchEvent(new CustomEvent('openchamber:focus-host', { detail: { hostId: '' } }));
    window.dispatchEvent(new CustomEvent('openchamber:focus-host', { detail: { hostId: 5 } }));
    window.dispatchEvent(new Event('openchamber:focus-host'));
    expect(focused).toEqual(['host-pi5']);

    stop();
    window.dispatchEvent(new CustomEvent('openchamber:focus-host', { detail: { hostId: 'local' } }));
    expect(focused).toEqual(['host-pi5']);
  });
});

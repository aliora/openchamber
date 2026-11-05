import { beforeEach, describe, expect, test } from 'bun:test';

import { HOST_ICON_CHOICES, useHostIconStore } from './host-icons';

describe('host icons', () => {
  beforeEach(() => {
    useHostIconStore.setState({ icons: {} });
  });

  test('keeps the picked icon per host and forgets it on reset', () => {
    const { setIcon } = useHostIconStore.getState();
    setIcon('local', 'macbook');
    setIcon('host:pi5', 'server');
    expect(useHostIconStore.getState().icons).toEqual({ local: 'macbook', 'host:pi5': 'server' });

    setIcon('local', null);
    expect(useHostIconStore.getState().icons).toEqual({ 'host:pi5': 'server' });
  });

  test('offers distinct icons', () => {
    expect(new Set(HOST_ICON_CHOICES).size).toBe(HOST_ICON_CHOICES.length);
  });
});

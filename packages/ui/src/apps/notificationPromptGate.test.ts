import { describe, expect, test } from 'bun:test';

import {
  markNotificationPromptDecided,
  readNotificationPromptDecided,
  shouldOfferNotificationPrompt,
} from './notificationPromptGate';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const brokenStorage = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

const offer = { ready: true, decided: false, nativeNotificationsEnabled: false, engineSetupOpen: false };

describe('mobile notification prompt gate', () => {
  test('offers once the phone is connected and nothing was decided', () => {
    expect(shouldOfferNotificationPrompt(offer)).toBe(true);
  });

  test('waits for the first successful connection', () => {
    expect(shouldOfferNotificationPrompt({ ...offer, ready: false })).toBe(false);
  });

  test('never asks again after a decision', () => {
    expect(shouldOfferNotificationPrompt({ ...offer, decided: true })).toBe(false);
  });

  test('stays away when notifications are already on', () => {
    expect(shouldOfferNotificationPrompt({ ...offer, nativeNotificationsEnabled: true })).toBe(false);
  });

  test('does not stack on top of the setup wizard', () => {
    expect(shouldOfferNotificationPrompt({ ...offer, engineSetupOpen: true })).toBe(false);
  });

  test('remembers the decision on this device', () => {
    const storage = memoryStorage();
    expect(readNotificationPromptDecided(storage)).toBe(false);
    expect(markNotificationPromptDecided(storage)).toBe(true);
    expect(readNotificationPromptDecided(storage)).toBe(true);
  });

  test('reads blocked storage as undecided', () => {
    expect(readNotificationPromptDecided(brokenStorage)).toBe(false);
    expect(markNotificationPromptDecided(brokenStorage)).toBe(false);
  });
});

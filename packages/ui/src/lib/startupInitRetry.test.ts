import { describe, expect, test } from 'bun:test';
import { RECOVERY_SCREEN_RETRY_DELAY_MS, startStartupInitRetry } from './startupInitRetry';

const manualTimers = () => {
  const pending: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    pending,
    setTimer: (callback: () => void, delayMs: number) => {
      pending.push({ callback, delayMs });
      return setTimeout(() => undefined, 0);
    },
    clearTimer: () => {
      pending.length = 0;
    },
    async fire() {
      const next = pending.shift();
      if (!next) throw new Error('no timer is pending');
      next.callback();
      await Promise.resolve();
      await Promise.resolve();
      return next.delayMs;
    },
  };
};

describe('startStartupInitRetry', () => {
  test('keeps retrying behind the recovery screen and clears it once the server answers', async () => {
    const timers = manualTimers();
    let initialized = false;
    let failuresLeft = 14;
    let attempts = 0;
    const exhausted: boolean[] = [];

    startStartupInitRetry({
      initialize: async () => {
        attempts += 1;
        if (failuresLeft > 0) failuresLeft -= 1;
        else initialized = true;
      },
      isInitialized: () => initialized,
      setExhausted: (value) => exhausted.push(value),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const delays: number[] = [];
    while (!initialized) delays.push(await timers.fire());

    expect(attempts).toBe(15);
    // The recovery screen shows after the tenth failed attempt, and the
    // attempts after it come at the recovery pace.
    expect(delays.slice(0, 10)).toEqual([1000, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000, 4000]);
    expect(delays.slice(10)).toEqual(Array(5).fill(RECOVERY_SCREEN_RETRY_DELAY_MS));
    expect(exhausted).toEqual([true, true, true, true, true, false]);
    expect(timers.pending).toEqual([]);
  });

  test('stops when the caller stops it', async () => {
    const timers = manualTimers();
    let attempts = 0;
    const stop = startStartupInitRetry({
      initialize: async () => { attempts += 1; },
      isInitialized: () => false,
      setExhausted: () => undefined,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await timers.fire();
    stop();

    expect(attempts).toBe(1);
    expect(timers.pending).toEqual([]);
  });
});

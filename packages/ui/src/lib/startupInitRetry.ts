const MAX_QUICK_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_QUICK_DELAY_MS = 4000;
// After the quick attempts the recovery screen shows, and it keeps checking at
// this pace: a desktop app opened at login, or one whose server is restarting,
// clears itself once the server answers instead of waiting for a Retry click.
export const RECOVERY_SCREEN_RETRY_DELAY_MS = 5_000;

type StartupInitRetryOptions = {
  initialize: () => Promise<void>;
  isInitialized: () => boolean;
  /** True once the quick attempts are spent and the recovery screen should show. */
  setExhausted: (exhausted: boolean) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Retries app initialization until it succeeds: quickly with backoff first,
 * then every RECOVERY_SCREEN_RETRY_DELAY_MS while the recovery screen shows.
 * Returns the function that stops it.
 */
export const startStartupInitRetry = ({
  initialize,
  isInitialized,
  setExhausted,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: StartupInitRetryOptions): (() => void) => {
  let active = true;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = async () => {
    if (!active) return;
    if (!isInitialized()) {
      attempts += 1;
      await initialize();
    }
    if (!active) return;
    if (isInitialized()) {
      setExhausted(false);
      return;
    }
    const quick = attempts < MAX_QUICK_ATTEMPTS;
    if (!quick) setExhausted(true);
    // Each attempt already waits for OpenCode on the server (a held health
    // probe), so the gap between quick attempts stays short.
    const delay = quick
      ? Math.min(BASE_DELAY_MS * Math.pow(2, attempts - 1), MAX_QUICK_DELAY_MS)
      : RECOVERY_SCREEN_RETRY_DELAY_MS;
    timer = setTimer(() => void attempt(), delay);
  };

  timer = setTimer(() => void attempt(), BASE_DELAY_MS);

  return () => {
    active = false;
    if (timer) clearTimer(timer);
  };
};

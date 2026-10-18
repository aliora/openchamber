import type { HostTransport } from '@/lib/hosts/host-transport';
import { PROFILE_UPDATED_AT_FIELD, type ProfileStamps } from './profile';
import { type DesktopSettings, type SettingsSurface } from './registry';
import { SETTINGS_SURFACE_QUERY, getSettingsSurface } from './surface';

export type ProfileFanOutTarget = Pick<HostTransport, 'fetch'>;

export type ProfileFanOutDependencies = {
  getTargets(): readonly ProfileFanOutTarget[];
  getSurface(): SettingsSurface;
  setTimer(callback: () => void, ms: number): () => void;
  debounceMs: number;
  requestTimeoutMs: number;
};

export type ProfileFanOut = {
  queue(values: DesktopSettings, stamps: ProfileStamps): void;
  flush(): Promise<void>;
  cancel(): void;
};

export const PROFILE_FAN_OUT_TIMING = {
  debounceMs: 1_500,
  requestTimeoutMs: 15_000,
};

export const createProfileFanOut = (dependencies: ProfileFanOutDependencies): ProfileFanOut => {
  let pendingValues: DesktopSettings = {};
  let pendingStamps: ProfileStamps = {};
  let cancelTimer: (() => void) | null = null;

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const sendTo = async (target: ProfileFanOutTarget, path: string, body: string): Promise<void> => {
    const controller = new AbortController();
    const cancelTimeout = dependencies.setTimer(() => controller.abort(), dependencies.requestTimeoutMs);
    try {
      const result = await target.fetch(path, { accept: 'application/json', signal: controller.signal, method: 'PUT', body });
      if (result.ok) await result.response.body?.cancel().catch(() => undefined);
    } finally {
      cancelTimeout();
    }
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    const values = pendingValues;
    const stamps = pendingStamps;
    pendingValues = {};
    pendingStamps = {};
    if (Object.keys(values).length === 0) return;
    const targets = dependencies.getTargets();
    if (targets.length === 0) return;
    const path = `/api/config/settings?${SETTINGS_SURFACE_QUERY}=${dependencies.getSurface()}`;
    const body = JSON.stringify({ ...values, [PROFILE_UPDATED_AT_FIELD]: stamps });
    await Promise.allSettled(targets.map((target) => sendTo(target, path, body)));
  };

  return {
    queue(values, stamps) {
      if (Object.keys(values).length === 0) return;
      pendingValues = { ...pendingValues, ...values };
      pendingStamps = { ...pendingStamps, ...stamps };
      clearTimer();
      cancelTimer = dependencies.setTimer(() => void flush(), dependencies.debounceMs);
    },
    flush,
    cancel() {
      clearTimer();
      pendingValues = {};
      pendingStamps = {};
    },
  };
};

let watchedTargets: () => readonly ProfileFanOutTarget[] = () => [];

export const registerProfileFanOutTargets = (getTargets: () => readonly ProfileFanOutTarget[]): void => {
  watchedTargets = getTargets;
};

export const profileFanOut = createProfileFanOut({
  getTargets: () => watchedTargets(),
  getSurface: getSettingsSurface,
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  ...PROFILE_FAN_OUT_TIMING,
});

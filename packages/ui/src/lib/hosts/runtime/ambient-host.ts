import type { HostRuntime } from './types';

let ambientHost: HostRuntime | null = null;

export const getAmbientHost = (): HostRuntime | null => ambientHost;

export const runWithHost = <T>(host: HostRuntime, fn: () => T): T => {
  const outer = ambientHost;
  ambientHost = host;
  try {
    return fn();
  } finally {
    ambientHost = outer;
  }
};

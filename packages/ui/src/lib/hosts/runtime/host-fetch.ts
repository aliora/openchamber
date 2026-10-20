import { runtimeFetch } from '@/lib/runtime-fetch';
import type { HostRuntime } from './types';

export const hostRuntimeFetch = (host: HostRuntime, ...request: Parameters<typeof runtimeFetch>): ReturnType<typeof runtimeFetch> => (
  host.run(() => runtimeFetch(...request))
);

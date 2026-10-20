import { currentRuntimeTransport } from '@/lib/hosts/runtime/runtime-transport';
import type { RuntimeUrlConfig, RuntimeUrlResolver } from '@/lib/hosts/runtime/transport-urls';

export { createRuntimeUrlResolver } from '@/lib/hosts/runtime/transport-urls';
export type { RuntimeUrlQuery, RuntimeUrlResolver } from '@/lib/hosts/runtime/transport-urls';

export const getRuntimeUrlResolver = (): RuntimeUrlResolver => currentRuntimeTransport().urls;

export const setRuntimeUrlResolver = (resolver: RuntimeUrlResolver): void => {
  currentRuntimeTransport().setUrls(resolver);
};

export const configureRuntimeUrlResolver = (config: RuntimeUrlConfig): RuntimeUrlResolver => currentRuntimeTransport().configureUrls(config);

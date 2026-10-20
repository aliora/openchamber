import { OpencodeService } from '@/lib/opencode/client';
import { createRelayTunnelClient, type RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { createRuntimeTransport } from './runtime-transport';
import { fetchWithoutRuntimeBridge } from './transport-fetch';
import type { RuntimeAuthCredentialProvider } from './transport-auth';
import type { HostRuntimeParts, HostStoreScope, RuntimeTransportEndpoint } from './types';

export const createHostParts = (
  runtimeKey: string,
  endpoint: RuntimeTransportEndpoint,
  readToken: RuntimeAuthCredentialProvider | null,
  storeScope: HostStoreScope | undefined,
  liveTunnel?: RelayTunnelClient,
): HostRuntimeParts => {
  const transport = createRuntimeTransport({ bootInjection: false, fetch: fetchWithoutRuntimeBridge, createTunnel: createRelayTunnelClient });
  if (readToken) transport.auth.setCredentialProvider(readToken);
  if (liveTunnel && endpoint.relay) transport.relay.adopt(endpoint.relay, liveTunnel);
  transport.reconfigure(endpoint);
  return { transport, client: new OpencodeService({ transport, runtimeKey: () => runtimeKey }), storeScope };
};

const sameHeaders = (left: Record<string, string> | null | undefined, right: Record<string, string> | null | undefined): boolean => {
  const leftEntries = Object.entries(left ?? {});
  if (leftEntries.length !== Object.keys(right ?? {}).length) return false;
  return leftEntries.every(([name, value]) => right?.[name] === value);
};

export const sameTransportEndpoint = (current: RuntimeTransportEndpoint | null, next: RuntimeTransportEndpoint): boolean => (
  current !== null
  && current.apiBaseUrl === next.apiBaseUrl
  && (current.clientToken || null) === (next.clientToken || null)
  && sameHeaders(current.requestHeaders, next.requestHeaders)
  && JSON.stringify(current.relay ?? null) === JSON.stringify(next.relay ?? null)
);

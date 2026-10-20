import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { OpencodeService } from '@/lib/opencode/client';
import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeApiBaseUrl, getRuntimeKey, routeRuntimeEndpoints, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint, type RoutedRuntimeEndpoint } from '@/lib/runtime-switch';
import { isTransientRuntimeKey } from '@/lib/transient-runtime-key';
import type { HostCredential, HostEndpoint, SavedHost } from '../types';
import { followAppHost, hostRegistry } from './host-bindings';
import { createHostParts, sameTransportEndpoint } from './host-parts';
import { isMultiHostRuntimeEnabled } from './multi-host-flag';
import { followWindowHost } from './window-host';
import { borrowRuntimeTransport, followFocusedHostTransport, windowRuntimeTransport } from './runtime-transport';
import type { HostId, HostRegistry, HostRuntimeParts, HostStoreScope, RuntimeTransport, RuntimeTransportEndpoint } from './types';

export { defineHostStore, hostRegistry, resolveHost } from './host-bindings';

const readActiveCredential = async (): Promise<HostCredential> => {
  const { auth } = windowRuntimeTransport();
  return { token: auth.bearerToken() || null, requestHeaders: auth.extraHeaders() };
};

const endpointOfTransport = (runtimeKey: string, apiUrl: string, relay: RuntimeTransportEndpoint['relay']): HostEndpoint => {
  if (relay) return { kind: 'relay', relay };
  return { kind: runtimeKey === 'local' ? 'local' : 'direct', apiUrl };
};

const savedHostFor = (runtimeKey: string, apiUrl: string, relay: RuntimeTransportEndpoint['relay']): SavedHost => {
  const endpoint = endpointOfTransport(runtimeKey, apiUrl, relay);
  return {
    descriptor: {
      id: runtimeKey,
      label: runtimeKey,
      kind: endpoint.kind,
      displayUrl: endpoint.kind === 'relay' ? `relay://${endpoint.relay.serverId}` : redactSensitiveUrl(apiUrl),
      runtimeKey,
      monitored: false,
    },
    endpoint,
  };
};

const readActiveHost = (): SavedHost => (
  savedHostFor(getRuntimeKey(), getRuntimeApiBaseUrl(), windowRuntimeTransport().relay.descriptor())
);

const readActiveEndpoint = (): RuntimeTransportEndpoint => {
  const { auth, relay } = windowRuntimeTransport();
  return { apiBaseUrl: getRuntimeApiBaseUrl(), clientToken: auth.bearerToken() || null, requestHeaders: auth.extraHeaders(), relay: relay.descriptor() };
};

let windowTransport: RuntimeTransport | null = null;
let windowClient: OpencodeService | null = null;
let windowStoreScope: HostStoreScope | null = null;

const readWindowParts = (host: SavedHost): HostRuntimeParts => {
  const transport = windowTransport ??= borrowRuntimeTransport(windowRuntimeTransport());
  if (windowStoreScope?.hostId !== host.descriptor.runtimeKey) windowStoreScope = { hostId: host.descriptor.runtimeKey };
  return {
    transport,
    get client() {
      windowClient ??= new OpencodeService({ transport, runtimeKey: () => (isMultiHostRuntimeEnabled() ? windowHostId ?? getRuntimeKey() : getRuntimeKey()) });
      return windowClient;
    },
    storeScope: windowStoreScope,
  };
};

let windowHostId: HostId | null = null;
let windowEndpoint: RuntimeTransportEndpoint | null = null;

const windowEndpointOf = (): RuntimeTransportEndpoint | null => windowRuntimeTransport().endpoint ?? windowEndpoint;

const rebuildActiveHost = (registry: HostRegistry): void => {
  const stale = windowHostId === null ? registry.list().map((previous) => previous.id) : [windowHostId];
  const host = registry.register(readActiveHost(), readActiveCredential);
  windowHostId = host.id;
  windowEndpoint = readActiveEndpoint();
  registry.focus(host.id);
  for (const id of stale) {
    if (id !== host.id) registry.unregister(id);
  }
};

const pendingTunnels = new Map<HostId, { descriptor: RelayRuntimeDescriptor; client: RelayTunnelClient }>();

const takePendingTunnel = (runtimeKey: string, relay: RuntimeTransportEndpoint['relay']): RelayTunnelClient | undefined => {
  const pending = pendingTunnels.get(runtimeKey);
  pendingTunnels.delete(runtimeKey);
  if (!pending) return undefined;
  if (relay?.serverId === pending.descriptor.serverId && relay.relayUrl === pending.descriptor.relayUrl) return pending.client;
  pending.client.close();
  return undefined;
};

const updateHostEndpoint = (registry: HostRegistry, runtimeKey: string, endpoint: RuntimeTransportEndpoint): void => {
  const existing = registry.get(runtimeKey);
  if (existing) {
    if (sameTransportEndpoint(existing.transport.endpoint, endpoint)) return;
    existing.transport.reconfigure(endpoint);
    existing.client.reconnectToRuntimeBaseUrl();
    return;
  }
  const parts = createHostParts(runtimeKey, endpoint, null, undefined, takePendingTunnel(runtimeKey, endpoint.relay));
  const readCredential = async (): Promise<HostCredential> => ({
    token: parts.transport.auth.bearerToken() || null,
    requestHeaders: parts.transport.auth.extraHeaders(),
  });
  registry.register(savedHostFor(runtimeKey, endpoint.apiBaseUrl, endpoint.relay), readCredential, parts);
};

const routeEndpointToHost = (registry: HostRegistry, routed: RoutedRuntimeEndpoint): 'window' | 'host' => {
  if (!isMultiHostRuntimeEnabled() || windowHostId === null) return 'window';
  const { runtimeKey, previousRuntimeKey, ...endpoint } = routed;
  const windowEndpointChanged = runtimeKey === windowHostId && !sameTransportEndpoint(windowEndpointOf(), endpoint);
  if (windowEndpointChanged) windowEndpoint = endpoint;
  if (runtimeKey !== windowHostId) updateHostEndpoint(registry, runtimeKey, endpoint);
  if (registry.get(runtimeKey)) registry.focus(runtimeKey);
  if (previousRuntimeKey !== runtimeKey && isTransientRuntimeKey(previousRuntimeKey)) registry.unregister(previousRuntimeKey);
  return windowEndpointChanged ? 'window' : 'host';
};

const isMultiHostWindow = (): boolean => isMultiHostRuntimeEnabled() && windowHostId !== null;

const endpointOfHost = (registry: HostRegistry, id: HostId): RuntimeTransportEndpoint | null => (
  id === windowHostId ? windowEndpointOf() : registry.get(id)?.transport.endpoint ?? null
);

const focusHost = (registry: HostRegistry, id: HostId, sshForwarded?: boolean): boolean => {
  const endpoint = isMultiHostWindow() && registry.get(id) ? endpointOfHost(registry, id) : null;
  if (!endpoint) return false;
  switchRuntimeEndpoint({ ...endpoint, runtimeKey: id, sshForwarded });
  return true;
};

let lastFocusedId: HostId | null = null;

const followFocusWithoutSwitch = (registry: HostRegistry): void => {
  const previous = lastFocusedId;
  lastFocusedId = registry.list().length > 0 ? registry.focused().id : null;
  if (!isMultiHostWindow() || previous === null || lastFocusedId === null || previous === lastFocusedId) return;
  if (registry.get(previous) || getRuntimeKey() !== previous) return;
  focusHost(registry, lastFocusedId);
};

let followingSwitches = false;

const followActiveRuntime = (registry: HostRegistry): void => {
  if (!followingSwitches) {
    followingSwitches = true;
    routeRuntimeEndpoints((routed) => routeEndpointToHost(registry, routed));
    subscribeRuntimeEndpointChanged(() => {
      if (!isMultiHostRuntimeEnabled()) rebuildActiveHost(registry);
    });
    registry.subscribe(() => followFocusWithoutSwitch(registry));
  }
  const missing = isMultiHostRuntimeEnabled() ? windowHostId === null : !registry.get(getRuntimeKey());
  if (missing) rebuildActiveHost(registry);
};

followAppHost({ createParts: readWindowParts, follow: followActiveRuntime });

followWindowHost(() => windowHostId);

followFocusedHostTransport(() => hostRegistry.focused().transport);

export const focusRegisteredHost = (id: HostId, options?: { sshForwarded?: boolean }): boolean => (
  focusHost(hostRegistry, id, options?.sshForwarded)
);

export const registerHostEndpoint = (id: HostId, endpoint: RuntimeTransportEndpoint): boolean => {
  if (!isMultiHostWindow() || id === windowHostId) return false;
  updateHostEndpoint(hostRegistry, id, endpoint);
  return true;
};

export const applyHostEndpoint = (id: HostId, endpoint: RuntimeTransportEndpoint): void => {
  if (!isMultiHostWindow() || !hostRegistry.get(id)) return;
  if (sameTransportEndpoint(endpointOfHost(hostRegistry, id), endpoint)) return;
  if (hostRegistry.focused().id === id) {
    switchRuntimeEndpoint({ ...endpoint, runtimeKey: id });
    return;
  }
  registerHostEndpoint(id, endpoint);
};

export const adoptRelayTunnelForHost = (id: HostId, descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (!isMultiHostWindow() || id === windowHostId) {
    windowRuntimeTransport().relay.adopt(descriptor, client);
    return;
  }
  const registered = hostRegistry.get(id);
  if (registered) {
    registered.transport.relay.adopt(descriptor, client);
    return;
  }
  pendingTunnels.get(id)?.client.close();
  pendingTunnels.set(id, { descriptor, client });
};

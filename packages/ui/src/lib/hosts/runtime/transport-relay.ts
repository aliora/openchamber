import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import { wrapBrowserWebSocket, type RelayTunnelClient, type RelayTunnelStatus, type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { wsUrlToTunnelPath } from '@/lib/relay/tunnel-payloads';

export type RuntimeRelay = {
  tunnel(): RelayTunnelClient | null;
  descriptor(): Omit<RelayRuntimeDescriptor, 'grant'> | null;
  isActive(): boolean;
  activate(descriptor: RelayRuntimeDescriptor): RelayTunnelClient;
  adopt(descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void;
  deactivate(): void;
  subscribeStatus(listener: (status: RelayTunnelStatus) => void): () => void;
};

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

export const createRuntimeRelay = (createTunnel: (descriptor: RelayRuntimeDescriptor) => RelayTunnelClient): RuntimeRelay => {
  let activeTunnel: RelayTunnelClient | null = null;
  let activeDescriptor: RelayRuntimeDescriptor | null = null;
  const activeStatusListeners = new Set<(status: RelayTunnelStatus) => void>();
  let detachActiveStatus: (() => void) | null = null;

  // Every replacement of the active tunnel goes through here, so status
  // subscribers follow the runtime tunnel instead of the one they first saw.
  const setActiveTunnel = (tunnel: RelayTunnelClient | null): void => {
    detachActiveStatus?.();
    detachActiveStatus = null;
    activeTunnel = tunnel;
    if (!tunnel) return;
    detachActiveStatus = tunnel.subscribeStatus((status) => {
      for (const listener of activeStatusListeners) listener(status);
    });
  };

  return {
    tunnel: () => activeTunnel,
    descriptor: () => {
      if (!activeTunnel || !activeDescriptor) return null;
      return {
        relayUrl: activeDescriptor.relayUrl,
        serverId: activeDescriptor.serverId,
        hostEncPubJwk: { ...activeDescriptor.hostEncPubJwk },
      };
    },
    isActive: () => activeTunnel !== null,
    activate: (descriptor) => {
      if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
        return activeTunnel;
      }
      activeTunnel?.close();
      activeDescriptor = descriptor;
      const tunnel = createTunnel(descriptor);
      setActiveTunnel(tunnel);
      return tunnel;
    },
    adopt: (descriptor, client) => {
      if (activeTunnel === client) {
        // Re-adopting the live runtime tunnel (a pairing redeemed through it):
        // keep the client, record the new descriptor so the following activate
        // call matches it.
        activeDescriptor = descriptor;
        return;
      }
      activeTunnel?.close();
      activeDescriptor = descriptor;
      setActiveTunnel(client);
    },
    deactivate: () => {
      activeTunnel?.close();
      setActiveTunnel(null);
      activeDescriptor = null;
    },
    subscribeStatus: (listener) => {
      activeStatusListeners.add(listener);
      return () => {
        activeStatusListeners.delete(listener);
      };
    },
  };
};

export const openTransportWebSocket = (relay: RelayTunnelClient | null, url: string, protocols?: string[]): RelayTunnelWebSocket => {
  if (relay) {
    return relay.openWebSocket(wsUrlToTunnelPath(url), protocols);
  }
  return wrapBrowserWebSocket(protocols ? new WebSocket(url, protocols) : new WebSocket(url));
};

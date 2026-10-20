import { currentRuntimeTransport } from '@/lib/hosts/runtime/runtime-transport';
import type { RuntimeRelay } from '@/lib/hosts/runtime/transport-relay';
import type { RelayTunnelClient, RelayTunnelStatus } from './tunnel-client';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

const currentRelay = (): RuntimeRelay => currentRuntimeTransport().relay;

/**
 * Status changes of whichever tunnel is the runtime's at the time. Only
 * changes are delivered; read `getActiveRelayTunnel()?.getStatus()` for the
 * current one.
 */
export const subscribeActiveRelayTunnelStatus = (listener: (status: RelayTunnelStatus) => void): (() => void) =>
  currentRelay().subscribeStatus(listener);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => currentRelay().tunnel();

export const getActiveRelayDescriptor = (): Omit<RelayRuntimeDescriptor, 'grant'> | null => currentRelay().descriptor();

export const isRelayModeActive = (): boolean => currentRelay().isActive();

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 * Reuses the existing client when the descriptor is unchanged so a redundant
 * runtime switch does not tear down a live tunnel.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => currentRelay().activate(descriptor);

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRelayTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  currentRelay().adopt(descriptor, client);
};

export const deactivateRelayTunnel = (): void => {
  currentRelay().deactivate();
};

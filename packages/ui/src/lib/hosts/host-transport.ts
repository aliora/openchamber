// How one monitored host is reached. The active runtime's transport
// (`runtime-fetch`, the runtime tunnel) always serves the host the window is
// connected to; a monitored host gets its own transport so its traffic never
// borrows the active runtime's address, token or tunnel.
//
// The credential is read on every request and goes only into the
// `Authorization` header. No token is ever placed in a URL.

import { createRelayTunnelClient, isRelayLimitReached, type RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { addRuntimeProxyHeaders } from '@/lib/runtime-fetch';
import type { HostCredential, HostRelayEndpoint, SavedHost } from './types';

export type HostFetchResult =
  | { ok: true; response: Response }
  | { ok: false; reason: 'unreachable' | 'relay-limit' | 'aborted' };

export type HostFetchOptions = {
  accept: string;
  signal: AbortSignal;
};

export type HostTransport = {
  /** GETs a path on the host. Resolves with the response, or why no response came. */
  fetch(path: string, options: HostFetchOptions): Promise<HostFetchResult>;
  /**
   * Gives up the relay tunnel so the runtime can adopt it when this host
   * becomes the active one. Returns it only while it is connected; a tunnel in
   * any other state is closed, so the runtime dials a fresh one.
   */
  releaseTunnel(): RelayTunnelClient | null;
  close(): void;
};

type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export type HostTransportDependencies = {
  fetch: FetchFunction;
  createTunnel: (relay: HostRelayEndpoint) => RelayTunnelClient;
  /** How long a direct request may wait for response headers before the address counts as unreachable. */
  directConnectTimeoutMs: number;
};

const defaultDependencies: HostTransportDependencies = {
  // Read at call time: the page installs its runtime fetch bridge after this
  // module loads, and that bridge passes other origins through untouched.
  fetch: (input, init) => globalThis.fetch(input, init),
  createTunnel: (relay) => createRelayTunnelClient(relay),
  directConnectTimeoutMs: 8_000,
};

const joinUrl = (apiUrl: string, path: string): string => `${apiUrl.replace(/\/+$/, '')}${path}`;

export const createHostTransport = (
  host: SavedHost,
  getCredential: () => Promise<HostCredential | null>,
  dependencies: HostTransportDependencies = defaultDependencies,
): HostTransport => {
  const { endpoint } = host;
  let tunnel: RelayTunnelClient | null = null;
  let closed = false;
  // A host with both legs keeps using whichever answered last.
  let preferRelay = false;

  const buildHeaders = async (accept: string): Promise<Headers> => {
    const credential = await getCredential().catch(() => null);
    const headers = new Headers({ Accept: accept });
    for (const [name, value] of Object.entries(credential?.requestHeaders ?? {})) {
      if (name.toLowerCase() !== 'authorization') headers.set(name, value);
    }
    if (credential?.token) headers.set('Authorization', `Bearer ${credential.token}`);
    return headers;
  };

  const fetchDirect = async (apiUrl: string, path: string, headers: Headers, signal: AbortSignal): Promise<HostFetchResult> => {
    const url = joinUrl(apiUrl, path);
    // The attempt has its own signal so a silent address times out; the
    // caller's signal still reaches it, which also ends a streaming body.
    const attempt = new AbortController();
    signal.addEventListener('abort', () => attempt.abort(), { once: true });
    const timer = setTimeout(() => attempt.abort(), dependencies.directConnectTimeoutMs);
    try {
      const response = await dependencies.fetch(url, {
        headers: addRuntimeProxyHeaders(url, headers),
        signal: attempt.signal,
        cache: 'no-store',
      });
      return { ok: true, response };
    } catch {
      return { ok: false, reason: signal.aborted ? 'aborted' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchRelay = async (relay: HostRelayEndpoint, path: string, headers: Headers, signal: AbortSignal): Promise<HostFetchResult> => {
    tunnel ??= dependencies.createTunnel(relay);
    const client = tunnel;
    // A tunnel parked on a terminal relay refusal redials only on a wake-up
    // event, which a window that stays visible never gets. The monitor's
    // backoff paces these fresh attempts.
    if (client.getStatus().state === 'error') client.retry();
    try {
      return { ok: true, response: await client.fetch(path, { headers, signal }) };
    } catch {
      if (signal.aborted) return { ok: false, reason: 'aborted' };
      return { ok: false, reason: isRelayLimitReached(client.getStatus()) ? 'relay-limit' : 'unreachable' };
    }
  };

  return {
    async fetch(path, { accept, signal }) {
      if (closed || signal.aborted) return { ok: false, reason: 'aborted' };
      const headers = await buildHeaders(accept);
      if (closed) return { ok: false, reason: 'aborted' };

      if (endpoint.kind === 'relay') return fetchRelay(endpoint.relay, path, headers, signal);
      if (endpoint.kind !== 'multi') return fetchDirect(endpoint.apiUrl, path, headers, signal);

      const viaRelay = () => fetchRelay(endpoint.relay, path, headers, signal);
      const viaDirect = () => fetchDirect(endpoint.apiUrl, path, headers, signal);
      const first = await (preferRelay ? viaRelay() : viaDirect());
      if (first.ok || first.reason === 'aborted') return first;
      const second = await (preferRelay ? viaDirect() : viaRelay());
      if (second.ok) {
        preferRelay = !preferRelay;
        return second;
      }
      // A relay refusal over its limits says more than a dead direct address.
      return first.reason === 'relay-limit' ? first : second;
    },

    releaseTunnel() {
      const current = tunnel;
      tunnel = null;
      if (!current) return null;
      if (current.getStatus().state === 'connected') return current;
      current.close();
      return null;
    },

    close() {
      closed = true;
      tunnel?.close();
      tunnel = null;
    },
  };
};

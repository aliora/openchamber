import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient, type RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getAmbientHost } from './ambient-host';
import { provideStandaloneTransport } from './host-bindings';
import { createRuntimeAuth } from './transport-auth';
import { createRuntimeFetch } from './transport-fetch';
import { createRuntimeRelay, openTransportWebSocket } from './transport-relay';
import { createRuntimeUrlResolver, type RuntimeUrlConfig } from './transport-urls';
import type { NetworkFetch, RuntimeTransport, RuntimeTransportEndpoint } from './types';

type RuntimeTransportOptions = {
  bootInjection: boolean;
  fetch: NetworkFetch;
  createTunnel: (descriptor: RelayRuntimeDescriptor) => RelayTunnelClient;
};

export const createRuntimeTransport = ({ bootInjection, fetch, createTunnel }: RuntimeTransportOptions): RuntimeTransport => {
  const relay = createRuntimeRelay(createTunnel);
  const auth = createRuntimeAuth({ relay, fetch, bootInjection });
  let urls = createRuntimeUrlResolver({ auth });
  let epoch = 0;
  let endpoint: RuntimeTransportEndpoint | null = null;

  const configureUrls = (config: RuntimeUrlConfig) => {
    urls = createRuntimeUrlResolver({ ...config, auth: config.auth ?? auth });
    return urls;
  };

  return {
    get urls() {
      return urls;
    },
    setUrls: (resolver) => {
      urls = resolver;
    },
    configureUrls,
    auth,
    relay,
    fetch: createRuntimeFetch({ urls: () => urls, auth, relay, fetch }),
    openWebSocket: (url, protocols) => openTransportWebSocket(relay.tunnel(), url, protocols),
    reconfigure: (next) => {
      const { apiBaseUrl, clientToken, requestHeaders, relay: relayDescriptor } = next;
      endpoint = next;
      configureUrls({ apiBaseUrl, realtimeBaseUrl: apiBaseUrl });
      auth.setExtraHeaders(requestHeaders || null);
      auth.setBearerToken(clientToken || null);
      // Relay mode routes runtime HTTP/WS through an E2EE tunnel instead of the
      // network. Activate the tunnel BEFORE minting the url token, since the mint
      // itself rides the tunnel (runtimeFetch -> tunnel.fetch).
      if (relayDescriptor) {
        relay.activate(relayDescriptor);
      } else {
        relay.deactivate();
      }
      epoch += 1;
      void auth.refreshUrlToken(apiBaseUrl).catch(() => {});
    },
    get epoch() {
      return epoch;
    },
    get endpoint() {
      return endpoint;
    },
    close: () => {
      relay.deactivate();
      auth.dispose();
    },
  };
};

export const borrowRuntimeTransport = (owner: RuntimeTransport): RuntimeTransport => ({
  get urls() {
    return owner.urls;
  },
  setUrls: (resolver) => owner.setUrls(resolver),
  configureUrls: (config) => owner.configureUrls(config),
  auth: owner.auth,
  relay: owner.relay,
  fetch: (input, init) => owner.fetch(input, init),
  openWebSocket: (url, protocols) => owner.openWebSocket(url, protocols),
  reconfigure: (endpoint) => owner.reconfigure(endpoint),
  get epoch() {
    return owner.epoch;
  },
  get endpoint() {
    return owner.endpoint;
  },
  close: () => {},
});

let windowTransport: RuntimeTransport | null = null;

export const windowRuntimeTransport = (): RuntimeTransport => {
  windowTransport ??= createRuntimeTransport({
    bootInjection: true,
    fetch: (input, init) => fetch(input, init),
    createTunnel: createRelayTunnelClient,
  });
  return windowTransport;
};

let readFocusedHostTransport: (() => RuntimeTransport) | null = null;

export const followFocusedHostTransport = (read: () => RuntimeTransport): void => {
  readFocusedHostTransport = read;
};

export const currentRuntimeTransport = (): RuntimeTransport =>
  getAmbientHost()?.transport ?? readFocusedHostTransport?.() ?? windowRuntimeTransport();

provideStandaloneTransport(() => borrowRuntimeTransport(windowRuntimeTransport()));

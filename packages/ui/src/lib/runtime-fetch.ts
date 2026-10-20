import { currentRuntimeTransport } from './hosts/runtime/runtime-transport';
import {
  addRuntimeProxyHeaders,
  isActiveRuntimeServiceUrl,
  rememberNativeWindowFetch,
  mergeHeaders,
  resolveRuntimeFetchUrl,
  shouldResolveFetchInput,
  tryRelayFetch,
  type RuntimeFetchOptions,
} from './hosts/runtime/transport-fetch';
import type { RuntimeUrlQuery } from './runtime-url';

export { addRuntimeProxyHeaders, fetchWithoutRuntimeBridge, isLatin1Safe, sanitizeHeadersForBrowser } from './hosts/runtime/transport-fetch';
export type { RuntimeFetchOptions } from './hosts/runtime/transport-fetch';

export const buildRuntimeFetchUrl = (input: string, query?: RuntimeUrlQuery): string =>
  resolveRuntimeFetchUrl(currentRuntimeTransport().urls, input, query);

export const runtimeFetch = (rawInput: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> =>
  currentRuntimeTransport().fetch(rawInput, init);

let runtimeFetchBridgeInstalled = false;

export const installRuntimeFetchBridge = (): void => {
  if (runtimeFetchBridgeInstalled || typeof window === 'undefined') return;
  runtimeFetchBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  rememberNativeWindowFetch(nativeFetch);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const transport = currentRuntimeTransport();
    const relayResponse = await tryRelayFetch(transport, input, init ?? {});
    if (relayResponse) return relayResponse;
    if (typeof input === 'string') {
      if (!shouldResolveFetchInput(input)) {
        try {
          const url = new URL(input);
          if (isActiveRuntimeServiceUrl(transport.urls, url)) {
            const headers = await mergeHeaders(transport.auth, undefined, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(input, { ...init, headers });
          }
        } catch {
          // Non-URL fetch inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(transport.auth, undefined, init?.headers);
      const target = resolveRuntimeFetchUrl(transport.urls, input);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof URL) {
      const raw = input.toString();
      if (!shouldResolveFetchInput(raw)) {
        if (isActiveRuntimeServiceUrl(transport.urls, input)) {
          const headers = await mergeHeaders(transport.auth, undefined, init?.headers);
          addRuntimeProxyHeaders(input.toString(), headers);
          return nativeFetch(input, { ...init, headers });
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(transport.auth, undefined, init?.headers);
      const target = resolveRuntimeFetchUrl(transport.urls, raw);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof Request) {
      if (!shouldResolveFetchInput(input.url)) {
        try {
          const url = new URL(input.url);
          if (isActiveRuntimeServiceUrl(transport.urls, url)) {
            const headers = await mergeHeaders(transport.auth, input.headers, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(new Request(input, { ...init, headers }));
          }
        } catch {
          // Non-URL request inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(transport.auth, input.headers, init?.headers);
      const target = resolveRuntimeFetchUrl(transport.urls, input.url);
      addRuntimeProxyHeaders(target, headers);
      const request = target === input.url ? input : new Request(target, input);
      return nativeFetch(new Request(request, { ...init, headers }));
    }

    return nativeFetch(input, init);
  };
};

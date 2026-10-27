import { TUNNEL_PARSE_BASE } from '@/lib/relay/tunnel-payloads';
import { observeRuntimeAuthResponse } from '@/lib/runtime-auth-expiry';
import { spaceDirectoryHeaders } from '@/lib/spaces/space-route';
import type { RuntimeAuth } from './transport-auth';
import type { RuntimeRelay } from './transport-relay';
import type { RuntimeUrlQuery, RuntimeUrlResolver } from './transport-urls';
import type { NetworkFetch } from './types';

let nativeWindowFetch: typeof fetch | null = null;

export const rememberNativeWindowFetch = (nativeFetch: typeof fetch): void => {
  nativeWindowFetch = nativeFetch;
};

/**
 * Fetches an absolute address as it is. The bridge in `runtime-fetch.ts` sends
 * a request for the page's own origin to the active runtime, and through its
 * relay tunnel when there is one; a caller that addresses another OpenChamber
 * host by URL (a monitored host, which can be Local on the page's own origin)
 * must reach that host instead, with only the headers it set.
 */
export const fetchWithoutRuntimeBridge = (input: string | URL | Request, init?: RequestInit): Promise<Response> => (
  (nativeWindowFetch ?? globalThis.fetch)(input, init)
);

export interface RuntimeFetchOptions extends RequestInit {
  query?: RuntimeUrlQuery;
  /**
   * The directory the request is about, when the request does not name it in its query or
   * its directory header. A directory inside an isolated space sends the request to that
   * space; see `withSpaceDirectory`.
   */
  directory?: string | null;
}

const shouldResolveApiPath = (input: string): boolean => {
  return input.startsWith('/api/') || input === '/api' || input.startsWith('/auth/') || input === '/auth' || input === '/health';
};

const getCurrentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.location.origin || '';
};

const isCurrentWindowUrl = (url: URL): boolean => {
  if (typeof window === 'undefined') return false;
  const currentOrigin = getCurrentOrigin();
  if (currentOrigin && url.origin === currentOrigin) return true;
  try {
    const current = new URL(window.location.href || currentOrigin);
    return url.protocol === current.protocol && url.host === current.host;
  } catch {
    return false;
  }
};

const isAbsoluteUrl = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

const isNgrokHost = (hostname: string): boolean =>
  /(^|\.)ngrok(?:-free)?\.(?:app|dev|io)$/i.test(hostname);

export const addRuntimeProxyHeaders = (url: string, headers: Headers): Headers => {
  try {
    if (isNgrokHost(new URL(url).hostname) && !headers.has('ngrok-skip-browser-warning')) {
      headers.set('ngrok-skip-browser-warning', 'openchamber');
    }
  } catch {
    // Relative and non-HTTP runtime paths do not need proxy-specific headers.
  }
  return headers;
};

const appendRuntimeQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;
  const entries = query instanceof URLSearchParams ? Array.from(query.entries()) : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

// ── Isolated spaces ────────────────────────────────────────────────────────
// The server sends a request to an isolated space when the request names a directory inside
// that space in its query or its `x-opencode-directory` header. A caller whose request names
// its directory only in its body passes it as `directory`: a space's directory then travels
// as that header, and a host directory adds nothing, so a host route reads the request as it
// always did. A header the caller set itself is left as it is; a request that names two
// different directories is the server's to refuse.
const hasDirectoryHeader = (headers: HeadersInit | undefined): boolean => {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has('x-opencode-directory');
  // Read without building a `Headers`: a caller's plain header may still hold characters the
  // Headers API refuses, which `sanitizeHeadersForBrowser` encodes later on the way out.
  const entries: Iterable<[string, string]> = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key] of entries) {
    if (key.toLowerCase() === 'x-opencode-directory') return true;
  }
  return false;
};

const withSpaceDirectory = (input: string | URL | Request, init: RequestInit, directory: string | null | undefined): RequestInit => {
  const spaceHeaders = spaceDirectoryHeaders(directory);
  if (spaceHeaders === null || hasDirectoryHeader(init.headers)) return init;
  if (input instanceof Request && input.headers.has('x-opencode-directory')) return init;
  const own: [string, string][] = !init.headers ? []
    : init.headers instanceof Headers ? Array.from(init.headers.entries())
    : Array.isArray(init.headers) ? init.headers : Object.entries(init.headers);
  return { ...init, headers: [...own, ...Object.entries(spaceHeaders)] };
};

/**
 * Where the runtime behind `urls` lives: its origin plus any sub-path prefix the host
 * is served under (https://host/openchamber), or null for a same-origin runtime.
 */
const activeRuntimeServiceRoot = (urls: RuntimeUrlResolver): string | null => {
  const apiBase = urls.api('/api');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(apiBase)) return null;
  const base = new URL(apiBase);
  return `${base.origin}${base.pathname.replace(/\/api$/, '')}`;
};

/** The service path of a URL on the runtime behind `urls`, with the host's sub-path prefix removed. */
const activeRuntimeServicePath = (urls: RuntimeUrlResolver, url: URL): string | null => {
  try {
    const root = activeRuntimeServiceRoot(urls);
    if (!root) return null;
    const rootUrl = new URL(root);
    if (url.origin !== rootUrl.origin) return null;
    const prefix = rootUrl.pathname.replace(/\/+$/, '');
    if (!prefix) return url.pathname;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    return url.pathname.slice(prefix.length) || '/';
  } catch {
    return null;
  }
};

export const isActiveRuntimeServiceUrl = (urls: RuntimeUrlResolver, url: URL): boolean => {
  const path = activeRuntimeServicePath(urls, url);
  return path !== null && shouldResolveApiPath(path);
};

export const shouldResolveFetchInput = (input: string): boolean => {
  if (shouldResolveApiPath(input)) return true;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return false;
  try {
    const url = new URL(input);
    return isCurrentWindowUrl(url) && shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
};

const buildRuntimeFetchUrlFromAbsolute = (urls: RuntimeUrlResolver, input: string, query?: RuntimeUrlQuery): string => {
  try {
    const url = new URL(input);
    if (!isCurrentWindowUrl(url)) return input;
    const rewritten = resolveRuntimeFetchUrl(urls, `${url.pathname}${url.search}`, query);
    if (!isAbsoluteUrl(rewritten) && (url.protocol === 'http:' || url.protocol === 'https:')) {
      appendRuntimeQuery(url, query);
      return url.toString();
    }
    return url.hash ? `${rewritten}${url.hash}` : rewritten;
  } catch {
    return input;
  }
};

export const resolveRuntimeFetchUrl = (urls: RuntimeUrlResolver, input: string, query?: RuntimeUrlQuery): string => {
  if (input === '/health') return urls.health(query);
  if (input.startsWith('/auth/') || input === '/auth') return urls.auth(input, query);
  if (shouldResolveApiPath(input)) return urls.api(input, query);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return buildRuntimeFetchUrlFromAbsolute(urls, input, query);
  return input;
};

const shouldAttachRuntimeAuth = (urls: RuntimeUrlResolver, input: string | URL | Request): boolean => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    return shouldResolveApiPath(raw);
  }

  try {
    return isActiveRuntimeServiceUrl(urls, new URL(raw));
  } catch {
    return false;
  }
};

// Headers API only accepts ISO-8859-1 (Latin-1) characters. Any value containing
// characters outside \u0000-\u00FF causes "Failed to construct/set 'Headers':
// String contains non ISO-8859-1 code point." Encode those values so they round-trip
// safely through the browser's Headers API. Directory hints get an explicit marker
// only when encoded, so plain ASCII paths remain compatible with routes that read
// the header directly.
export const isLatin1Safe = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const shouldEncodeHeaderValue = (_key: string, value: string): boolean => !isLatin1Safe(value);

export const sanitizeHeadersForBrowser = (init?: HeadersInit): [string, string][] | undefined => {
  if (!init) return undefined;
  // Normalize any HeadersInit shape into a plain array of entries so we can
  // safely inspect and re-encode non-Latin-1 values.
  const sourceEntries: [string, string][] = init instanceof Headers
    ? Array.from(init.entries())
    : Array.isArray(init)
      ? init
      : Object.entries(init);
  if (sourceEntries.length === 0) return undefined;
  const entries: [string, string][] = [];
  let dirty = false;
  let encodedDirectoryHint = false;
  for (const [key, value] of sourceEntries) {
    if (shouldEncodeHeaderValue(key, value)) {
      entries.push([key, encodeURIComponent(value)]);
      dirty = true;
      if (key.toLowerCase() === 'x-opencode-directory') encodedDirectoryHint = true;
    } else {
      entries.push([key, value]);
    }
  }
  if (encodedDirectoryHint) {
    entries.push(['x-opencode-directory-encoding', 'uri']);
  }
  return dirty ? entries : undefined;
};

export const mergeHeaders = async (auth: Pick<RuntimeAuth, 'buildHeaders'>, inputHeaders?: HeadersInit, initHeaders?: HeadersInit, attachAuth = true): Promise<Headers> => {
  const headers = new Headers(sanitizeHeadersForBrowser(inputHeaders) ?? inputHeaders);
  if (initHeaders) {
    new Headers(sanitizeHeadersForBrowser(initHeaders) ?? initHeaders).forEach((value, key) => headers.set(key, value));
  }
  if (!attachAuth) {
    return headers;
  }
  return auth.buildHeaders(headers);
};

type RuntimeFetchScope = {
  urls(): RuntimeUrlResolver;
  auth: Pick<RuntimeAuth, 'buildHeaders'>;
  relay: Pick<RuntimeRelay, 'tunnel'>;
};

// ── Relay-mode routing ─────────────────────────────────────────────────────
// When the runtime is a private relay, runtime HTTP does not go to the
// network: it rides the E2EE tunnel. We route exactly the same paths we would
// resolve for a network runtime (/api, /auth, /health) and attach identical
// auth headers; the bearer/url-token semantics are unchanged, only the
// transport differs. Non-runtime requests (external URLs) fall through to the
// real network fetch.
const appendPathQuery = (path: string, query?: RuntimeUrlQuery): string => {
  if (!query) return path;
  const url = new URL(path, TUNNEL_PARSE_BASE);
  appendRuntimeQuery(url, query);
  return `${url.pathname}${url.search}`;
};

const extractRelayPath = (input: string | URL | Request, query?: RuntimeUrlQuery): string | null => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    if (!shouldResolveApiPath(raw)) return null;
    return appendPathQuery(raw, query);
  }
  try {
    const url = new URL(raw);
    if (!isCurrentWindowUrl(url) || !shouldResolveApiPath(url.pathname)) return null;
    appendRuntimeQuery(url, query);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

export const tryRelayFetch = async (
  scope: Pick<RuntimeFetchScope, 'auth' | 'relay'>,
  input: string | URL | Request,
  requestInit: RequestInit,
  query?: RuntimeUrlQuery,
): Promise<Response | null> => {
  const relay = scope.relay.tunnel();
  if (!relay) return null;
  const path = extractRelayPath(input, query);
  if (path === null) return null;
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  const headers = await mergeHeaders(scope.auth, inputHeaders, requestInit.headers, true);
  if (input instanceof Request) {
    // Forward the Request itself — the tunnel reads its method/body/signal
    // natively (incl. stream bodies). Re-wrapping as `new Request(path, input)`
    // throws on a stream body without duplex:'half'.
    return relay.fetch(input, { ...requestInit, headers });
  }
  return relay.fetch(path, { ...requestInit, headers });
};

const resolveRuntimeFetchInput = (urls: RuntimeUrlResolver, input: string | URL | Request, query?: RuntimeUrlQuery): string | URL | Request => {
  if (typeof input === 'string') {
    return resolveRuntimeFetchUrl(urls, input, query);
  }

  if (input instanceof URL) {
    return resolveRuntimeFetchUrl(urls, input.toString(), query);
  }

  const target = resolveRuntimeFetchUrl(urls, input.url, query);
  return target === input.url ? input : new Request(target, input);
};

// ---------------------------------------------------------------------------
// In-flight read coalescing
//
// On cold start two independent data layers (the sync bootstrap and the config
// store) fire the SAME idempotent reads — providers, config, path, agents,
// project — concurrently, with no shared dedup. That saturates the single
// OpenCode process and delays everything queued behind it (e.g. createSession).
// Coalesce genuinely-concurrent identical GETs to those read endpoints so
// OpenCode does the work once; every caller gets an independent `clone()`.
//
// Scope is deliberately tight: GET only, an allowlist of read paths, never an
// event stream, and never a request carrying an AbortSignal (so one caller
// aborting can't cancel the shared fetch for the others). The entry is removed
// as soon as the request settles, so this only ever shares overlapping in-flight
// requests — it never serves a stale/cached response.
// ---------------------------------------------------------------------------
const COALESCE_READ_PATH = /\/api\/(config|path|app\/agents|agent|project|command)(\b|\/|\?|$)/;

// OpenCode 2.x scopes these reads by the `x-opencode-directory` header, not
// the URL, so two projects asking for `/api/config` at once must not share
// one response.
const coalesceReadKey = (method: string, url: string, hasSignal: boolean, headers: Headers): string | null => {
  if (hasSignal) return null;
  if (method !== 'GET') return null;
  if (url.includes('/event')) return null;
  if (!COALESCE_READ_PATH.test(url)) return null;
  return `GET ${url}\u0000${headers.get('x-opencode-directory') ?? ''}`;
};

export const createRuntimeFetch = (scope: RuntimeFetchScope & { auth: RuntimeAuth; fetch: NetworkFetch }) => {
  const inFlightReads = new Map<string, Promise<Response>>();

  const scopeFetch = async (rawInput: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {
    const urls = scope.urls();
    const { query, directory, ...ownInit } = init;
    // Before either transport: the relay and the network see the same headers.
    const input = rawInput;
    const requestInit = withSpaceDirectory(input, ownInit, directory);

    // Resolve the transport once — relay tunnel or network — then apply the SAME
    // read-coalescing to both. On a relay the tunnel is bandwidth/latency-bound, so
    // deduping concurrent identical GETs matters there most.
    const relay = scope.relay.tunnel();
    const relayPath = relay ? extractRelayPath(input, query) : null;

    let doFetch: () => Promise<Response>;
    let url: string;
    let method: string;
    let scopeHeaders: Headers;
    if (relay && relayPath !== null) {
      const inputHeaders = input instanceof Request ? input.headers : undefined;
      const headers = await mergeHeaders(scope.auth, inputHeaders, requestInit.headers, true);
      doFetch = input instanceof Request
        ? () => relay.fetch(input, { ...requestInit, headers })
        : () => relay.fetch(relayPath, { ...requestInit, headers });
      scopeHeaders = headers;
      url = relayPath;
      method = String(requestInit.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    } else {
      const resolvedInput = resolveRuntimeFetchInput(urls, input, query);
      const inputHeaders = resolvedInput instanceof Request ? resolvedInput.headers : undefined;
      const headers = await mergeHeaders(scope.auth, inputHeaders, requestInit.headers, shouldAttachRuntimeAuth(urls, resolvedInput));
      const resolvedUrl =
        resolvedInput instanceof Request ? resolvedInput.url
        : resolvedInput instanceof URL ? resolvedInput.toString()
        : String(resolvedInput);
      addRuntimeProxyHeaders(resolvedUrl, headers);
      doFetch = resolvedInput instanceof Request
        ? () => scope.fetch(new Request(resolvedInput, { ...requestInit, headers }))
        : () => scope.fetch(resolvedInput, { ...requestInit, headers });
      scopeHeaders = headers;
      url = resolvedUrl;
      method = String(
        requestInit.method ?? (resolvedInput instanceof Request ? resolvedInput.method : 'GET'),
      ).toUpperCase();
    }

    // Session-expiry classification rides on responses that already flow
    // through here; only the status is read, never the body.
    const rawFetch = doFetch;
    doFetch = () => rawFetch().then((response) => {
      observeRuntimeAuthResponse({ auth: scope.auth, fetch: scopeFetch }, url, response.status);
      return response;
    });

    // A Request always carries a (possibly default) signal; treat any Request, or
    // an explicit init.signal, as "has signal" and skip coalescing for safety.
    const hasSignal = requestInit.signal != null || input instanceof Request;

    const key = coalesceReadKey(method, url, hasSignal, scopeHeaders);
    if (!key) return doFetch();

    const existing = inFlightReads.get(key);
    if (existing) return existing.then((res) => res.clone());

    const pending = doFetch();
    inFlightReads.set(key, pending);
    pending.then(
      () => inFlightReads.delete(key),
      () => inFlightReads.delete(key),
    );
    return pending.then((res) => res.clone());
  };

  return scopeFetch;
};

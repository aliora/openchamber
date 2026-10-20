import type { StoreApi, UseBoundStore } from 'zustand';

import type { OpencodeService } from '@/lib/opencode/client';
import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import type { HostConnection, HostCredential, HostDescriptor, SavedHost } from '../types';
import type { RuntimeAuth } from './transport-auth';
import type { RuntimeFetchOptions } from './transport-fetch';
import type { RuntimeRelay } from './transport-relay';
import type { RuntimeUrlConfig, RuntimeUrlResolver } from './transport-urls';

export type HostId = string;

export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RuntimeTransportEndpoint = {
  apiBaseUrl: string;
  clientToken?: string | null;
  requestHeaders?: Record<string, string> | null;
  relay?: RelayRuntimeDescriptor | null;
};

export type RuntimeTransport = {
  readonly urls: RuntimeUrlResolver;
  setUrls(resolver: RuntimeUrlResolver): void;
  configureUrls(config: RuntimeUrlConfig): RuntimeUrlResolver;
  readonly auth: RuntimeAuth;
  readonly relay: RuntimeRelay;
  fetch(input: string | URL | Request, init?: RuntimeFetchOptions): Promise<Response>;
  openWebSocket(url: string, protocols?: string[]): RelayTunnelWebSocket;
  reconfigure(endpoint: RuntimeTransportEndpoint): void;
  readonly epoch: number;
  readonly endpoint: RuntimeTransportEndpoint | null;
  close(): void;
};

export type HostStatus = { connection: HostConnection };

export type HostStoreScope = { readonly hostId: HostId };

export type HostStoreKey<S> = {
  readonly name: string;
  readonly resolve: (host: HostRuntime) => StoreApi<S>;
};

export type HostRuntime = {
  readonly id: HostId;
  readonly descriptor: HostDescriptor;
  readonly transport: RuntimeTransport;
  readonly client: OpencodeService;
  readonly status: StoreApi<HostStatus>;
  readonly storeScope: HostStoreScope;
  instance<S>(key: HostStoreKey<S>): StoreApi<S>;
  run<T>(fn: () => T): T;
  readonly disposed: boolean;
  dispose(): void;
};

export type HostCredentialReader = () => Promise<HostCredential | null>;

export type HostRuntimeParts = {
  readonly transport: RuntimeTransport;
  readonly client: OpencodeService;
  storeScope?: HostStoreScope;
};

export type CreateHostRuntimeParts = (host: SavedHost, credential: HostCredentialReader) => HostRuntimeParts;

export type HostRegistry = {
  get(id: HostId): HostRuntime | undefined;
  list(): readonly HostRuntime[];
  focused(): HostRuntime;
  focus(id: HostId): void;
  register(host: SavedHost, credential: HostCredentialReader, parts?: HostRuntimeParts): HostRuntime;
  unregister(id: HostId): void;
  subscribe(listener: () => void): () => void;
};

export type EveryHostListener<S> = (state: S, previousState: S, host: HostRuntime) => void;

export type HostBoundStore<S, A extends StoreApi<S> = StoreApi<S>> = UseBoundStore<StoreApi<S>> & {
  forHost(id: HostId): A;
  subscribeEveryHost(listener: EveryHostListener<S>): () => void;
};

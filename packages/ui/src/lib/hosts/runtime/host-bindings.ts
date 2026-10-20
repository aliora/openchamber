import type { OpencodeService } from '@/lib/opencode/client';
import type { SavedHost } from '../types';
import { createHostBindings } from './focus-facade';

export { bindHostActions } from './focus-facade';
import { createHostRegistry } from './host-registry';
import type { CreateHostRuntimeParts, HostRegistry, HostRuntime, HostRuntimeParts, RuntimeTransport } from './types';

type AppHostFollower = {
  createParts: CreateHostRuntimeParts;
  follow: (registry: HostRegistry) => void;
};

const STANDALONE_HOST_ID = 'standalone';

const standaloneHost: SavedHost = {
  descriptor: {
    id: STANDALONE_HOST_ID,
    label: STANDALONE_HOST_ID,
    kind: 'local',
    displayUrl: '',
    runtimeKey: STANDALONE_HOST_ID,
    monitored: false,
  },
  endpoint: { kind: 'local', apiUrl: '' },
};

let readStandaloneTransport: (() => RuntimeTransport) | null = null;

export const provideStandaloneTransport = (read: () => RuntimeTransport): void => {
  readStandaloneTransport = read;
};

const standaloneParts = (): HostRuntimeParts => {
  let transport: RuntimeTransport | null = null;
  return {
    get transport() {
      if (!readStandaloneTransport) throw new Error('The standalone host has no transport: no runtime transport is loaded');
      transport ??= readStandaloneTransport();
      return transport;
    },
    get client(): OpencodeService {
      throw new Error('The standalone host has no OpenCode client: the app host is not loaded');
    },
  };
};

let follower: AppHostFollower | null = null;

const registry = createHostRegistry((host, credential) => (follower ? follower.createParts(host, credential) : standaloneParts()));

const follow = (): void => {
  if (follower) {
    follower.follow(registry);
    return;
  }
  if (registry.list().length === 0) registry.register(standaloneHost, async () => null);
};

export const followAppHost = (next: AppHostFollower): void => {
  follower = next;
};

export const hostRegistry: HostRegistry = {
  ...registry,
  get: (id) => {
    follow();
    return registry.get(id);
  },
  list: () => {
    follow();
    return registry.list();
  },
  focused: () => {
    follow();
    return registry.focused();
  },
};

export const { resolveHost, defineHostStore, defineHostValue } = createHostBindings(hostRegistry);

export const hostStoresLive = (host: HostRuntime): boolean => hostRegistry.get(host.id)?.storeScope === host.storeScope;

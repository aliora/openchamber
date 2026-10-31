// Contracts for the saved OpenChamber hosts a window runs beside each other.
// DOCUMENTATION.md in this folder describes them.

/** How this window reaches a host: its own server, an HTTP address, the private relay, or both. */
export type HostKind = 'local' | 'direct' | 'relay' | 'multi';

/** What the UI may show and keep about a saved host. Holds no credential and no raw address. */
export type HostDescriptor = {
  id: string;
  label: string;
  kind: HostKind;
  /** The address with anything credential-like redacted, or `relay://<serverId>` for a relay-only host. */
  displayUrl: string;
  /** The runtime key the window uses while this host is active: `local` or `host:<id>`. */
  runtimeKey: string;
  monitored: boolean;
};

/** The relay leg of a host. `hostEncPubJwk` pins the tunnel to the real server. */
export type HostRelayEndpoint = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

/** Where a host answers. Kept by the transport, never by a store. */
export type HostEndpoint =
  | { kind: 'local' | 'direct'; apiUrl: string }
  | { kind: 'relay'; relay: HostRelayEndpoint }
  | { kind: 'multi'; apiUrl: string; relay: HostRelayEndpoint };

export type SavedHost = {
  descriptor: HostDescriptor;
  endpoint: HostEndpoint;
};

/** A host's credential, read from the runtime's own store each time a request needs it. */
export type HostCredential = {
  token: string | null;
  /** Extra headers the user saved for the host. Never carries `Authorization`. */
  requestHeaders: Readonly<Record<string, string>>;
};

export type HostSessionState = 'idle' | 'running' | 'waiting-permission' | 'waiting-input' | 'failed';

export type HostTurnOutcome = 'succeeded' | 'failed' | 'interrupted';

/** One session of a host as the sidebar lists it, read from the host's own stores. */
export type HostSessionSummary = {
  id: string;
  parentID?: string;
  title: string;
  directory: string;
  providerId?: string;
  modelId?: string;
  createdAt?: number;
  updatedAt: number;
  state: HostSessionState;
  /** The last finished turn, when the host saw one since it started. */
  outcome?: HostTurnOutcome;
  /** The last finished turn is newer than the last view any client recorded on the host (`sync/session-unread.ts`). */
  unread?: true;
  /** A session of the host's managed Chats rather than of a project folder. */
  chat?: boolean;
  /** The host's project holding the session's folder; null when none does. Absent from hosts that predate projects. */
  projectId?: string | null;
  work: 'open' | null;
  /** Pinned in the session's metadata, which every client of the host shares. */
  pinned?: true;
  scheduled?: true;
};

/** One of a host's projects, as its summary lists them. */
export type HostProject = {
  id: string;
  label: string;
  path: string;
  /** The project's place in the host's own list. */
  order: number;
  isDefault: boolean;
};

/**
 * Why the last attempt to reach a host failed:
 * `unreachable` no answer or a dropped connection, `server-error` 5xx, 408 or 429,
 * `rejected` any other 4xx.
 */
export type HostFailure = 'unreachable' | 'server-error' | 'rejected';

/**
 * The connection to one host. `live` means its event stream is connected, or,
 * while it is not, the host answers polling. `auth-required`, `incompatible`
 * (the host has no status route) and `relay-limit` wait for a long backoff or
 * a wake-up instead of retrying fast.
 */
export type HostConnection =
  | { state: 'connecting' }
  | { state: 'live'; since: number; via: 'stream' | 'poll' }
  | { state: 'backoff'; failure: HostFailure; retryAt: number }
  | { state: 'auth-required' }
  | { state: 'incompatible' }
  | { state: 'relay-limit' };

/**
 * A host's session list. `loading` has no data yet; `error` keeps the last
 * complete list, so an empty map under `error` means "unknown", never "no
 * sessions".
 */
export type HostSnapshot = {
  status: 'loading' | 'ready' | 'error';
  sessions: ReadonlyMap<string, HostSessionSummary>;
  lastCompleteAt: number | null;
  /** The host's projects from its last complete list; absent when the host predates projects. */
  projects?: readonly HostProject[];
};

/** What the sidebar reads per monitored host. */
export type MonitoredHost = {
  descriptor: HostDescriptor;
  connection: HostConnection;
  snapshot: HostSnapshot;
};

/**
 * Whether this window runs other hosts: `unknown` before the first host
 * list, `unsupported` on single-host surfaces, `error` when the list could not
 * be read (the previous hosts stay).
 */
export type HostsAvailability = 'unknown' | 'unsupported' | 'ready' | 'error';

export type HostsListResult =
  | { status: 'unsupported' }
  | { status: 'ok'; hosts: SavedHost[] };

# Hosts

The desktop app and the phone app save several OpenChamber hosts and run all of them at once: every saved host has its own runtime (transport, SDK client, sync engine, stores; see `runtime/DOCUMENTATION.md`), and the window's focus says which one the chat column shows. There is no host switcher. A click on another host's session moves the focus there; Settings → Hosts (desktop) and the Instances surface (phone) add, rename and remove hosts.

This module is the part every surface sees: the contracts, the rows the sidebar draws for the hosts beside the focused one, opening a session of one of them, and the transports other features borrow.

Web, VS Code, hosted mobile and a desktop window opened for one host are single-host by construction (`runtime/multi-host-flag.ts` is off there): they run no host feed and read `availability: 'unsupported'`.

## Files

| File | Owns |
|---|---|
| `types.ts` | The contracts: `HostDescriptor`, `HostEndpoint`, `HostCredential`, `HostConnection`, `HostSnapshot`, `HostSessionSummary`. |
| `host-transport.ts` | `createHostTransport(host, getCredential)`: one host's own HTTP address or relay tunnel, the credential on every request; `hostTransportOverRuntime(runtime)`: the same shape over a runtime's transport; `createHostRequest`. |
| `hosts-store.ts` | The zustand store the sidebar reads: availability, the rows of the hosts beside the focused one, the focused saved host. Holds no credential and no raw address. |
| `hosts-monitoring.ts` | `hostsMonitoring`: the entry the app calls (`ensure`, `refresh`, `watchedTransports`, `transportFor`, `stop`). It hands every call to the runtime feed (`runtime/runtime-hosts-monitoring.ts`) once `SyncProvider` installed it; on a single-host surface `ensure` marks the store `unsupported`. |
| `useMonitoredHosts.ts` | The hook the sidebar uses, and `refreshMonitoredHosts()` for a Refresh action. |
| `active-host.ts` | `isActiveHost(host, activeKey)`: whether a saved host is the one the window is on, by runtime key or by its `url:` key. |
| `open-host-session.ts` | Opening a session of another host, or a draft there: move the focus, then open. |
| `open-host-draft.ts` | `openDraftInDirectory`: a draft in the host project that holds a directory, once that host's projects are known. |
| `hostSessionOpenerContext.ts` | `HostSessionOpenerContext`: the desktop opener by default, the phone's inside `MobileApp`. |
| `host-model-catalog.ts` | A host's model catalog read through a `HostRequest`. |
| `apps/mobileHosts.ts` | The phone app's `HostsAPI`: its saved connections as hosts, and each token read from the Keychain or Keystore. |
| `apps/mobileHostSessionOpener.ts` | `mobileHostSessionOpener`: the same opener, focusing a running device or connecting one that is not. |

The server's summary routes (`packages/web/server/lib/engine/session-summary.js`) stay for other clients; nothing in this app reads them any more. The sidebar's host level is `components/session/sidebar/hosts/` (see "Other hosts" in its `DOCUMENTATION.md`).

## What the sidebar reads

```ts
const { availability, hosts, activeHost } = useMonitoredHosts();
// availability: 'unknown' | 'unsupported' | 'ready' | 'error'
// hosts: { descriptor, connection, snapshot }[], every saved host but the focused one
// activeHost: the descriptor of the saved host the window is focused on, or null
```

- `descriptor` names the host: `label`, `kind` (`local`, `direct`, `relay`, `multi`), a redacted `displayUrl`, and its `runtimeKey` (`local` or `host:<id>` on the desktop; the relay key or the normalized address on the phone).
- `connection` is the host runtime's own `status.connection`, kept by its supervisor (`runtime/host-connection-supervisor.ts`): `live` while its event stream is connected or it answers polling, `connecting` before the first answer, `backoff` with why the last attempt failed (`unreachable`, `server-error`, `rejected`) and when the next one runs, `auth-required`, `incompatible` (no status route), `relay-limit`.
- `snapshot` is projected from the host's own stores (`runtime/host-snapshot.ts`): its global sessions, live statuses, pending requests and, once known, its projects. `status` is `loading` before the first complete list, `ready` after one, `error` after a failed load, which keeps the last complete list: an empty map under `loading` or `error` means "not known", never "no sessions".
- A session row is `{ id, parentID?, title, directory, providerId?, updatedAt, state, outcome?, chat?, projectId?, work }`. `state` is `idle`, `running`, `waiting-permission`, `waiting-input` or `failed`, from the pending requests first, then the live status, then the last turn's outcome. `work` is `'open'` while the session in the host's own global sessions store is in work (`metadata.openchamber.work.state`), else null. `projectId` names the host project holding the folder, absent until the host's projects are known. `chat` is set by no runtime projection yet.
- `activeHost` lets the sidebar head the focused host's sessions with its name. A window keyed by an address (`url:<address>`) is on the saved host with that address. It is null when the focused key matches no saved host.

An entry object changes only when that host changes, and a row that did not change keeps its object, so memoized rows stay cheap. `availability: 'error'` keeps the hosts already shown. One host failing never touches another host's entry.

## Runtimes

| Runtime | Behavior |
|---|---|
| Electron desktop, the app's own page | Lists this machine (Local, under the label the user gave it, `desktopLocalHostLabel`, else "This Mac" or "This computer") plus every saved host from the shell (`desktop_hosts_get`). Each request reads the host's token from the shell at call time. |
| Electron desktop, a window opened for one host | Single-host: `unsupported`. |
| Web, hosted mobile, VS Code | `unsupported`. |
| Capacitor mobile | Lists the phone's saved connections from `apps/mobileConnections.ts` (`apps/mobileHosts.ts`). A connection with a LAN address and a relay is `multi`, one with only either is `direct` or `relay`. |

## Opening a session of another host

`hostSessionOpener.open({ host, target, onProblem })` opens a session (`{ kind: 'session', sessionId, directory }`) or a draft (`{ kind: 'draft', directory? }`) on a host:

1. On the focused host it opens at once.
2. Otherwise it moves the focus (`focusHost`): on the desktop `switchToDesktopHost` (`lib/desktopHostActions.ts`), which focuses a host that runs beside the others without a probe or reconnect; on the phone `focusRegisteredHost`, or, for a device not running yet, the saved connection's connect. A host that does not answer is focused all the same: its chat column says it is offline or connecting (`components/auth/FocusedHostGate.tsx`), and one that needs a sign-in shows its own gate there.
3. The session opens from the host's own list right away. Only a complete list that no longer has it reports `missing`; a list still loading opens it anyway. A focus that did not move reports `failed` and opens nothing.

Clicks run one after another and the last one wins: a click made while a focus move runs replaces what earlier clicks would open.

`hostSessionOpener.openInHostWindow(host, sessionId)` opens the session in the host's own desktop window through `desktop_open_host_session`, which validates the session id in the main process and reuses a window already open on that host. It returns false where the shell cannot, and the sidebar then opens the session in this window.

Drafts are keyed by runtime, directory and session (`lib/chatDraftPersistence.ts`, the attachment drafts in `sync/input-store.ts`), so an unsent message is there again when the focus comes back to its host.

## Adding, renaming and removing hosts

- **Desktop**: Settings → Hosts (`components/sections/remote-instances/RemoteInstancesPage.tsx`, "Connected hosts") lists this machine first, then every saved host, each with its runtime's connection dot (`HostListRow.tsx`, `useHostConnection`). Add by address or by a pairing link, edit a direct host's address, token and headers, rename any host (this machine's name is `desktopLocalHostLabel`; an empty name brings back the default), remove any host but this machine. Edits are pure (`hostListEdits.ts`) and saved through `desktop_hosts_set`; `refreshMonitoredHosts()` then re-reads the list, so a removed host leaves the registry (its transport closes, its stores go with its runtime) and a renamed one shows its new name. Nothing there switches or activates a host.
- **Phone**: the Instances surface lists each saved device with its runtime's connection dot. A tap connects only a device that is not live (to sign in again or retry); an edit, a removal and pairing stay as they were. Removing the device the window is on focuses the most recent remaining one.

## Security

- Credentials stay in the desktop shell's `settings.json`, or in the phone's Keychain or Keystore, and reach a request only through `HostsAPI.getCredential` or a host transport. They are never written to zustand, `localStorage`, a URL, a log or an error text.
- `displayUrl` is redacted with `redactSensitiveUrl`.
- Every host authenticates its requests exactly as when the window used to switch to it; the status probe sits behind the server's UI auth gate.
- Enterprise mode is unchanged: the app only connects out to hosts the user saved and opens no new listener.

## Tests

`host-transport.test.ts`, `open-host-session.test.ts`, `open-host-draft.test.ts`, `host-model-catalog.test.ts` and `useMonitoredHosts.test.tsx` run with `bun test <file>`. The phone's host list, its active host and its opener are in `apps/mobileHosts.test.ts` and `apps/mobileHostSessionOpener.test.ts`; its In work rows and host sections in `apps/MobileHostSections.test.tsx`. The Hosts list edits round trip is `components/sections/remote-instances/hostListEdits.test.ts`, the offline marker `components/auth/FocusedHostGate.test.tsx`, and the rows the runtimes produce `runtime/host-snapshot.test.ts` and `apps/runtimeEndpointReset.test.ts`.

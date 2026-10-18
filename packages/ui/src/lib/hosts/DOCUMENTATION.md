# Monitored hosts

The desktop app and the phone app can save several OpenChamber hosts. The window talks to one of them at a time, the active host, through the regular runtime transport and session stores. This module watches every other saved host: their sessions and what each session is doing, so the sidebar can show all hosts together.

The active host is never monitored here. The sidebar reads it from today's stores (`useGlobalSessionsStore`, the sync child stores, `global-session-status.ts`) and reads the other hosts from `useMonitoredHosts()`.

## Files

| File | Owns |
|---|---|
| `types.ts` | The contracts: `HostDescriptor`, `HostEndpoint`, `HostCredential`, `HostConnection`, `HostSnapshot`, `HostSessionSummary`. |
| `host-transport.ts` | How one host is reached: its HTTP address, its own relay tunnel, or both. Attaches the credential to every request. |
| `host-monitor.ts` | One host's list: the summary stream, polling while the stream is down, backoff. |
| `hosts-store.ts` | The zustand store the sidebar reads. Holds no credential and no raw address. |
| `hosts-monitoring.ts` | One monitor per saved host except the active one, and the hand-over on a runtime switch. |
| `useMonitoredHosts.ts` | The hook the sidebar uses, and `refreshMonitoredHosts()` for a Refresh action. |
| `open-host-session.ts` | Opening a monitored host's session, or a draft there: the switch, the wait for the host's list, and what happens when either fails. |
| `apps/mobileHosts.ts` | The phone app's `HostsAPI`: its saved connections as hosts, and each token read from the Keychain or Keystore. |
| `apps/mobileHostSessionOpener.ts` | `mobileHostSessionOpener`, the same opener with the phone's connect as the switch. |

The server side is `packages/web/server/lib/engine/session-summary.js`. The sidebar's host level is `components/session/sidebar/hosts/` (see "Other hosts" in its `DOCUMENTATION.md`).

## What the sidebar reads

```ts
const { availability, hosts, activeHost } = useMonitoredHosts();
// availability: 'unknown' | 'unsupported' | 'ready' | 'error'
// hosts: { descriptor, connection, snapshot }[], every saved host but the active one
// activeHost: the descriptor of the saved host the window is on, or null
```

- `descriptor` names the host: `label`, `kind` (`local`, `direct`, `relay`, `multi`), a redacted `displayUrl`, and the `runtimeKey` a switch to it uses (`local` or `host:<id>`).
- `connection` says whether the list is current. `live` is current, through the stream or, while the stream is down, through polling (`via`). `backoff` carries why the last attempt failed and when the next one runs. `auth-required` needs the user to sign in again. `incompatible` is a host without the summary routes, usually an older version. `relay-limit` means the relay refused the tunnel over its limits.
- `snapshot.status` is `loading` before the first list, `ready` after a complete one, and `error` after a failed attempt. `error` keeps the last complete list and its `lastCompleteAt`, so an empty map under `loading` or `error` means "not known", never "no sessions".
- `activeHost` names the host the window is connected to, so the sidebar can head its own sessions with it. A window keyed by an address (`url:<address>`) is on the saved host with that address: a window opened for a host and the main window started on a remote default host know their host only that way. It is null when the window's runtime key matches no saved host, and it is never monitored.
- `snapshot.projects` is the host's project list from its last complete list, `{ id, label, path, order, isDefault }[]`; it is absent for a host that predates projects.
- A session row is `{ id, parentID?, title, directory, engine, updatedAt, state, outcome?, chat?, projectId? }`. `chat` marks a session of the host's managed Chats. `projectId` names the host project holding the session's folder, null when none does. `state` is `idle`, `running`, `waiting-permission`, `waiting-input` or `failed`. The server derives it from the session runtime, the pending permission requests and the last turn's outcome. It never sends message content.

An entry object changes only when that host changes, and a row that did not change keeps its object, so memoized rows stay cheap. `availability: 'error'` keeps the hosts already shown: a failed read of the saved hosts is not an empty list. One host failing never touches another host's entry.

The first `useMonitoredHosts()` call starts monitoring with the runtime's `hosts` API. Monitoring then runs for the life of the page. The phone app starts it from `MobileApp`, so the hosts are watched before the sessions sheet first opens.

## Runtimes

| Runtime | Behavior |
|---|---|
| Electron desktop, local page | Lists Local plus every saved host from the desktop shell (`desktop_hosts_get`). Each request reads the host's token from the shell at call time. |
| Electron desktop, page served by another instance | `unsupported`. The shell hands such a page the host list without tokens. |
| Web | `unsupported`. A browser has no saved hosts. |
| Hosted mobile | `unsupported`, same as web. |
| Capacitor mobile | Lists the phone's saved connections from `apps/mobileConnections.ts` (`apps/mobileHosts.ts`, loaded on demand by `packages/web/src/api/hosts.ts`). A connection with a LAN address and a relay is `multi`, one with only either is `direct` or `relay`. The descriptor's `runtimeKey` is the key the phone switches with: `relay:<serverId>@<relayUrl>` when the connection has a relay, else its normalized address, so the connection the phone is on is the active host. Each request reads the token from the Keychain or Keystore at call time. |
| VS Code | `unsupported` (`packages/vscode/webview/api/hosts.ts`). The extension saves no hosts. |

A runtime fixture without `hosts` reads as `unsupported`.

## Transport

`createHostTransport(host, getCredential)` reaches one host:

- A direct or Local host gets the window's own `fetch` to its address (`fetchWithoutRuntimeBridge` in `lib/runtime-fetch.ts`), never the page's runtime fetch bridge: the bridge sends an address on the page's own origin to the active runtime, so Local, watched from a page Local serves while the window is on another host, read that host's list. A direct address that sends no response headers within 8 seconds counts as unreachable.
- A relay host gets its own `createRelayTunnelClient`. The active runtime's tunnel is never borrowed. A tunnel parked on a terminal relay refusal redials only on a wake-up event, which a window that stays visible never gets, so each request through a parked tunnel first asks it for one fresh attempt. The monitor's backoff paces those requests.
- A host with both legs tries the leg that answered last and falls back to the other.
- The credential is read through `getCredential` on every request and goes into the `Authorization` header only. No token is placed in a URL, and none is kept in the store.

## Monitor lifecycle

The monitor opens `GET /api/sessions/summary/stream` with `fetch`, so the bearer header works on every transport. The stream begins with a complete snapshot and then sends one row per change of state, pending request or title, and `removed` for a deleted session. A heartbeat comment arrives every 15 seconds.

| Event | Result |
|---|---|
| Snapshot arrives | List replaced, `ready`, `live` via stream |
| Stream ends after 30 seconds or more | Healthy: reconnect after 1 second, backoff resets |
| Stream ends early, drops, or is silent for 45 seconds | `backoff` with `interrupted`, list kept as `error` |
| No answer, 5xx, 408, 429 | `backoff`, 1s doubling to 30s visible, to 5 minutes hidden or offline |
| Other 4xx or a body that does not parse | `backoff` for 5 minutes, no polling |
| 401 or 403 | `auth-required`, waits 5 minutes |
| 404 | `incompatible`, waits 5 minutes |
| Relay refused over its limits | `relay-limit`, waits 5 minutes |

While the stream is down for a retryable reason, the monitor polls `GET /api/sessions/summary` every 10 seconds while the page is visible and every 60 seconds while it is hidden. A successful poll makes the connection `live` via poll. Coming back online, the page becoming visible, or `refreshMonitoredHosts()` ends every wait and retries at once.

Each monitor run gets a generation from one counter shared by all hosts. The store drops any write whose generation is not the host's current one, so a request that completes after the host was stopped, or after it left and came back, changes nothing.

## Opening a session of another host

The phone app uses `mobileHostSessionOpener` from `apps/mobileHostSessionOpener.ts`. It is the same opener, except that the switch is `connectSavedMobileConnection(host.id)`, which probes the saved connection's transports and switches like the cold-launch auto-connect, and `openInHostWindow` always returns false. A connection that answers unreachable, needs a sign-in or hits the relay limit does not switch, so the opener reports `failed`.

`hostSessionOpener.open({ host, connection, target, confirmLeavingDraft, onProblem })` opens a session (`target: { kind: 'session', sessionId, directory }`) or a new draft (`{ kind: 'draft', directory? }`) on a monitored host. A draft with a `directory` opens in the host's project that holds it; the host's projects load after the switch, so `openDraftInDirectory` (`open-host-draft.ts`) waits for that project, up to 10 seconds, before opening the draft there. The opener comes from `HostSessionOpenerContext` (`hostSessionOpenerContext.ts`): the desktop opener by default, `mobileHostSessionOpener` inside the phone app.

1. On the host the window is already on, it opens at once.
2. A host whose connection is not `live`, `auth-required` or `incompatible` is not switched to: `onProblem('unreachable')`, or `'connecting'` before its first answer. Switching blind to a host that does not answer would leave the window on the loading screen.
3. A mounted composer that holds an unsent message (`lib/composerDraftProbe.ts`, registered by `ChatInput`) asks `confirmLeavingDraft()` first; no switches nothing.
4. The window switches through `switchToDesktopHost` (`lib/desktopHostActions.ts`): Local in place, a relay host direct first with the tunnel as fallback, a direct host at its address. When the runtime key did not change afterwards, the switch failed: the window stays on its host and `onProblem('failed')`.
5. The wanted target waits, keyed by the host's runtime key, for the host's first complete global session list after the switch (the reset on the runtime change empties the list first). Then the session opens, or `onProblem('missing')` when the host no longer lists it, and the window stays on the host.

Switches run one after another. A second click while a switch to the same host is under way only changes what opens at the end; a click on another host waits for the running switch and then moves on, so the last click wins. A runtime change to another host after the window arrived drops the wait.

`hostSessionOpener.openInHostWindow(host, sessionId)` opens the session in the host's own desktop window through `desktop_open_host_session`, which validates the session id in the main process and reuses a window already open on that host. It returns false where the shell cannot, and the sidebar then opens the session in this window.

## Runtime switch hand-over

`apps/runtimeEndpointReset.ts` on web and desktop, and the runtime subscriber in `apps/MobileApp.tsx` on the phone, call `hostsMonitoring.prepareRuntimeSwitch` on the will-change event and `completeRuntimeSwitch` on the changed event:

1. Before the switch, the monitor of the host becoming active stops and the host leaves the store. A connected relay tunnel of that monitor is adopted as the runtime tunnel (`adoptRelayTunnel`), so the switch reuses it instead of dialing the same server twice. When the switch already holds a tunnel to that server, for example the switcher's probe, the monitor's tunnel is closed instead. A tunnel that is not connected is closed, so the runtime dials a fresh one.
2. After the switch, the host the window left gets a monitor on a fresh generation, and the saved hosts are read again.

A change that keeps the runtime key, such as a sign-in or a relay-to-direct transport swap, hands nothing over.

On the phone, monitors follow the page's visibility like everywhere else: hidden pages back off and poll slowly, and iOS suspends the web view in the background. The phone's resume handler calls `hostsMonitoring.refresh()`, so every host retries at once when the app comes back, even when the web view missed the `visibilitychange` event.

## Security

- Credentials stay in the desktop shell's `settings.json`, or in the phone's Keychain or Keystore, and reach a request only through `HostsAPI.getCredential`. They are never written to zustand, `localStorage`, a URL, a log or an error text.
- `displayUrl` is redacted with `redactSensitiveUrl`.
- The summary routes sit behind the server's UI auth gate like every engine route. A monitored host authenticates the request exactly as it does when the window is connected to it.
- Enterprise mode is unchanged by monitoring: it only connects out to hosts the user already saved and opens no new listener. See `packages/web/server/lib/enterprise-mode.js`.

## Tests

`host-transport.test.ts`, `host-monitor.test.ts`, `hosts-store.test.ts`, `hosts-monitoring.test.ts`, `open-host-session.test.ts` and `useMonitoredHosts.test.tsx` run with `bun test <file>`. The hand-over through the real switch event is in `apps/runtimeEndpointReset.test.ts`. The routes are covered by `packages/web/server/lib/engine/session-summary.test.js`, and the desktop host list by `packages/web/src/api/hosts.test.ts`. The phone's host list, its active host and its opener are in `apps/mobileHosts.test.ts` and `apps/mobileHostSessionOpener.test.ts`.

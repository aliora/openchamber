# Monitored hosts

The desktop app can save several OpenChamber hosts. The window talks to one of them at a time, the active host, through the regular runtime transport and session stores. This module watches every other saved host: their sessions and what each session is doing, so the sidebar can show all hosts together.

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

The server side is `packages/web/server/lib/engine/session-summary.js`.

## What the sidebar reads

```ts
const { availability, hosts } = useMonitoredHosts();
// availability: 'unknown' | 'unsupported' | 'ready' | 'error'
// hosts: { descriptor, connection, snapshot }[], every saved host but the active one
```

- `descriptor` names the host: `label`, `kind` (`local`, `direct`, `relay`, `multi`), a redacted `displayUrl`, and the `runtimeKey` a switch to it uses (`local` or `host:<id>`).
- `connection` says whether the list is current. `live` is current, through the stream or, while the stream is down, through polling (`via`). `backoff` carries why the last attempt failed and when the next one runs. `auth-required` needs the user to sign in again. `incompatible` is a host without the summary routes, usually an older version. `relay-limit` means the relay refused the tunnel over its limits.
- `snapshot.status` is `loading` before the first list, `ready` after a complete one, and `error` after a failed attempt. `error` keeps the last complete list and its `lastCompleteAt`, so an empty map under `loading` or `error` means "not known", never "no sessions".
- A session row is `{ id, parentID?, title, directory, engine, updatedAt, state, outcome? }`. `state` is `idle`, `running`, `waiting-permission`, `waiting-input` or `failed`. The server derives it from the session runtime, the pending permission requests and the last turn's outcome. It never sends message content.

An entry object changes only when that host changes, and a row that did not change keeps its object, so memoized rows stay cheap. `availability: 'error'` keeps the hosts already shown: a failed read of the saved hosts is not an empty list. One host failing never touches another host's entry.

The first `useMonitoredHosts()` call starts monitoring with the runtime's `hosts` API. Monitoring then runs for the life of the page.

## Runtimes

| Runtime | Behavior |
|---|---|
| Electron desktop, local page | Lists Local plus every saved host from the desktop shell (`desktop_hosts_get`). Each request reads the host's token from the shell at call time. |
| Electron desktop, page served by another instance | `unsupported`. The shell hands such a page the host list without tokens. |
| Web | `unsupported`. A browser has no saved hosts. |
| Hosted mobile | `unsupported`, same as web. |
| Capacitor mobile | `unsupported`. The phone keeps its own saved connections in `apps/mobileConnections.ts`, with tokens in the Keychain or Keystore; monitoring them is a later step built on that list. |
| VS Code | `unsupported` (`packages/vscode/webview/api/hosts.ts`). The extension saves no hosts. |

A runtime fixture without `hosts` reads as `unsupported`.

## Transport

`createHostTransport(host, getCredential)` reaches one host:

- A direct or Local host gets a plain `fetch` to its address. The page's fetch bridge passes another origin through untouched. A direct address that sends no response headers within 8 seconds counts as unreachable.
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

## Runtime switch hand-over

`apps/runtimeEndpointReset.ts` calls `hostsMonitoring.prepareRuntimeSwitch` on the will-change event and `completeRuntimeSwitch` on the changed event:

1. Before the switch, the monitor of the host becoming active stops and the host leaves the store. A connected relay tunnel of that monitor is adopted as the runtime tunnel (`adoptRelayTunnel`), so the switch reuses it instead of dialing the same server twice. When the switch already holds a tunnel to that server, for example the switcher's probe, the monitor's tunnel is closed instead. A tunnel that is not connected is closed, so the runtime dials a fresh one.
2. After the switch, the host the window left gets a monitor on a fresh generation, and the saved hosts are read again.

A change that keeps the runtime key, such as a sign-in or a relay-to-direct transport swap, hands nothing over.

## Security

- Credentials stay in the desktop shell's `settings.json` and reach a request only through `HostsAPI.getCredential`. They are never written to zustand, `localStorage`, a URL, a log or an error text.
- `displayUrl` is redacted with `redactSensitiveUrl`.
- The summary routes sit behind the server's UI auth gate like every engine route. A monitored host authenticates the request exactly as it does when the window is connected to it.
- Enterprise mode is unchanged by monitoring: it only connects out to hosts the user already saved and opens no new listener. See `packages/web/server/lib/enterprise-mode.js`.

## Tests

`host-transport.test.ts`, `host-monitor.test.ts`, `hosts-store.test.ts`, `hosts-monitoring.test.ts` and `useMonitoredHosts.test.tsx` run with `bun test <file>`. The hand-over through the real switch event is in `apps/runtimeEndpointReset.test.ts`. The routes are covered by `packages/web/server/lib/engine/session-summary.test.js`, and the desktop host list by `packages/web/src/api/hosts.test.ts`.

# Engine

OpenChamber drives coding CLIs as child processes. Each CLI is an engine adapter. The shared code here owns sessions, live streaming, permission prompts and the HTTP routes, so a new CLI only maps its own process and output.

## Files

| File | Owns |
|---|---|
| `registry.js` | The list of adapters. The first adapter is the default engine. |
| `routes.js` | Every engine HTTP route, mounted where the OpenCode proxy used to be, behind the UI auth gate. |
| `session-runtime.js` | One live CLI process per session and its queue of prompts. |
| `turn-translator.js` | Engine events of one prompt to OpenCode 2.x wire events, plus the assistant message to store. |
| `store.js` | Sessions and messages in `~/.openchamber/data/sessions.json`. |
| `control-bridge.js` | Pending permission prompts until the user answers or the 2 minute timeout denies them. |
| `stream-hub.js` | SSE subscribers per session and the `global` stream. |
| `session-summary.js` | The compact session list with live state that another OpenChamber window reads to monitor this server. |
| `claude/` | The Claude Code adapter. |

## Adapter contract

`registry.js` rejects an adapter that misses a required field.

| Field | Meaning |
|---|---|
| `id` | Stored on each session as `engine`. Never rename it: stored sessions point at it. |
| `displayName` | Shown to the user. |
| `providerID` | Provider id in `/api/provider` and on wire messages. Unique per engine. |
| `models`, `defaultModel` | `{ id, name }` list. A prompt with a model outside the list gets 400. |
| `efforts`, `defaultEffort` | Optional. Reasoning levels the CLI accepts. |
| `permissionModes`, `defaultPermissionMode` | Values the CLI accepts. Anything else gets 400 before a process starts. |
| `installer` | `getStatus(force)`, `install()`, `getLogs()`, and `log` and `status` events. |
| `auth` | `status()`, `login()`, `logout()`. `login()` must not block the request. |
| `createProcess(options)` | Returns an engine process. `options` holds `sessionId`, `cwd`, `model`, `effort`, `permissionMode`, `resume`. |

An engine process is an `EventEmitter` with `isAlive`, `start()`, `sendUserMessage(text)`, `respondPermission(requestId, 'allow' | 'deny')` and `abort()`. It emits:

| Event | Payload |
|---|---|
| `reasoning.delta` | `{ text }` |
| `text.delta` | `{ text }` |
| `tool.started` | `{ id, name, input }` |
| `permission.requested` | `{ requestId, toolName, input, summary }` |
| `turn.completed` | `{ outcome: 'succeeded' \| 'failed', usage }`, with `usage` as `{ input, output, reasoning, cacheRead, cacheWrite }` |
| `error`, `exit` | The process failed or ended. |

## Invariants

- A session's engine is fixed when it is created. `PATCH` ignores `engine`, because a CLI cannot resume another CLI's transcript.
- A stored session without `engine` belongs to the default engine. Those are sessions from before engines existed.
- A session whose engine is no longer registered stays on disk. Listing skips it and opening it returns 409.
- Each prompt gets its own assistant message. A CLI answers prompts in order, so events go to the oldest unfinished turn.
- When the process exits or fails mid-turn, every queued turn ends as `failed` and its partial text is still stored. Abort ends them as `interrupted`.
- Permission replies from the UI arrive as OpenCode's `once`, `always` or `reject`. `once` and `always` allow the call, `reject` denies it. Nothing is remembered across calls yet.

## Session summary

`GET /api/sessions/summary` answers `{ sessions }`, one row per listed session: `{ id, parentID?, title, directory, engine, updatedAt, state, outcome? }`. `GET /api/sessions/summary/stream` is SSE: a `{ type: 'snapshot', sessions }` event first, then `{ type: 'session', session }` whenever a session's state, pending request or title changes, `{ type: 'removed', id }` when one is deleted, and a `: heartbeat` comment every 15 seconds. Both are registered before `/api/sessions/:id` and sit behind the UI auth gate like every route here. Neither carries message content. The client is `packages/ui/src/lib/hosts/`.

`state` is read from the owner of each fact when a row is built:

| State | Source |
|---|---|
| `waiting-permission` | The control bridge holds an unanswered request for the session. |
| `running` | The runtime has a prompt queued or being answered (`isTurnActive`). A live process between turns is not running. |
| `failed` | The last finished turn failed and no new one started. |
| `idle` | Anything else. |

`waiting-input` is part of the contract for engines that ask questions; no engine asks one yet. `outcome` is the last finished turn's `succeeded`, `failed` or `interrupted`, kept in memory only, so after a restart every session reads `idle` without one.

The runtime announces each turn start and end (`subscribeActivity`), the control bridge each change to a session's pending requests (`subscribe`), including the silent timeout, and the routes announce creation, title edits and deletion. A notification that leaves the row unchanged sends nothing.

## Adding a CLI

1. Create `<engine>/adapter.js` with a factory returning the adapter above. Keep binary discovery and spawning in `<engine>/platform.js`, like `claude/`.
2. Map the CLI's own output to the engine events. Drop events the UI cannot show yet, do not invent wire events.
3. Register the factory in `packages/web/server/index.js`, after Claude so Claude stays the default.
4. Add a test with the CLI's recorded output. `test/fake-engine.js` shows the process shape the runtime expects.

Notes on the next candidates, checked 2026-10:

- **Codex.** `codex app-server` speaks JSON-RPC over stdio: `initialize`, then `thread/start` or `thread/resume`, then `turn/start`. It streams `item/*` notifications with deltas and sends approvals as server requests, which maps onto `permission.requested`. `codex exec --json` only emits whole messages, so it cannot drive live text. Generate the schema from the installed binary with `codex app-server generate-json-schema`.
- **Antigravity (`agy`).** Headless mode takes `--output-format stream-json` and `--input-format stream-json` together, from version 1.1.8. Headless runs cannot prompt for permissions, so the adapter has to choose its permission modes from what the CLI allows non-interactively. Exit code 3 marks a model or agent error.

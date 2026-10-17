# Engine

OpenChamber drives coding CLIs as child processes. Each CLI is an engine adapter. The shared code here owns sessions, live streaming, permission prompts and the HTTP routes, so a new CLI only maps its own process and output.

## Files

| File | Owns |
|---|---|
| `registry.js` | The list of adapters. The first adapter is the default engine. |
| `routes.js` | Every engine HTTP route, mounted where the OpenCode proxy used to be, behind the UI auth gate. |
| `catalog.js` | The OpenCode 2.x model and provider records the model picker reads, whether each engine's CLI is installed and signed in, and the readiness answer that greys out an engine in the picker. See *Catalog*. |
| `session-runtime.js` | One live CLI process per session and its queue of prompts. |
| `turn-translator.js` | Engine events of one prompt to OpenCode 2.x wire events, plus the assistant message to store and, while the turn runs, its current state. |
| `wire-messages.js` | Stored messages to the OpenCode 2.x messages the history routes serve, and paging. See *History*. |
| `store.js` | Sessions and messages in `~/.openchamber/data/sessions.json`. Every server on the machine shares the file: each one re-reads it before a read or write when it changed on disk, and an unreadable file is moved aside as `sessions.json.unreadable-<time>`, never saved over. |
| `control-bridge.js` | Pending permission prompts until the user answers or the 2 minute timeout denies them. |
| `stream-hub.js` | SSE subscribers per session and the `global` stream. Gives every event an `id`, which the UI requires of a wire event. |
| `tool-server.js` | What every adapter needs to hand its CLI OpenChamber's tool server: the child environment that keeps the server's host away from a proxy. See *Tool server*. |
| `session-summary.js` | The compact session list with live state that another OpenChamber window reads to monitor this server. |
| `cli-platform.js` | Finding, spawning, running and stopping a CLI binary from its known install paths, `where.exe` or the login shell. Used by `claude/` and `codex/`. |
| `cli-installer.js` | Version detection and `npm install -g` with streamed logs, for CLIs published on npm. Used by `claude/` and `codex/`. |
| `claude/` | The Claude Code adapter. |
| `antigravity/` | The Antigravity CLI (`agy`) adapter. |
| `codex/` | The Codex CLI adapter. |
| `test/` | `fake-engine.js` for route tests, `fake-codex.js` and the recorded `codex/*.ndjson` transcripts it plays, and the recorded route answers the UI's client test reads (`history-page.json`, `catalog-responses.json`). |

## Adapter contract

`registry.js` rejects an adapter that misses a required field.

| Field | Meaning |
|---|---|
| `id` | Stored on each session as `engine`. Never rename it: stored sessions point at it. |
| `displayName` | Shown to the user. |
| `providerID` | Provider id in `/api/provider` and on wire messages. The registry rejects two engines with the same one, because picking a model picks its engine. |
| `modelCatalog()` | Answers `{ models, defaultModel }` at once, without waiting for the CLI. `models` is a `{ id, name }` list and `defaultModel` one of its ids. A prompt or a model pick with a model outside the list gets 400. A model may add `family`, and `efforts` when the reasoning levels it offers differ from the adapter's; see *Catalog*. Claude Code and Antigravity answer a fixed list, Codex the list its CLI reported (*The Codex adapter*), so a route reads it once per request and uses that answer throughout. The registry checks the answer it gets at registration. |
| `startModelCatalog()` | Optional. Starts reading the models from the CLI in the background. `index.js` calls it once the routes are set up; a second call reads nothing new. Only Codex has it. |
| `limit` | Optional. `{ context, output }` in tokens, the sizes the CLI states for its models. A missing size is the catalog's conservative one; see *Catalog*. |
| `efforts`, `defaultEffort` | Optional. Reasoning levels the CLI accepts, for every model that lists none of its own. A model's efforts are its variants in the model picker, and a prompt or model pick with an effort the model does not offer gets 400. A model with an empty list, such as Antigravity's `default`, takes no effort, so any effort passes for it. Picking another model of the same engine without a variant keeps the session's effort when the new model offers it, and otherwise sets `defaultEffort`. |
| `permissionModes`, `defaultPermissionMode` | Values the CLI accepts. Anything else gets 400 before a process starts or anything is stored. |
| `livePermissionModes` | Optional. The modes a running process takes through its `setPermissionMode(mode)`, at once and mid-turn. Any other mode reaches the CLI when its next process starts. See *Session settings*. |
| `dangerousPermissionModes` | Optional. Modes that let the CLI run every tool without asking. The composer marks them. |
| `installer` | `getStatus(force)`, `install()`, `getLogs()`, and `log` and `status` events. `getStatus()` reports `installCommand`, what a user runs in a terminal to install the CLI: `npm install -g <package>` for a CLI on npm, the install script for Antigravity. The model picker shows it for a CLI that is missing. A CLI the server cannot install reports `canInstall: false`; the install route then answers 400 with `installCommand`. |
| `auth` | `status()`, `login()`, `logout()`, and optionally `loginCommand`. `login()` must not block the request. `logout()` may return a promise; the route answers once it settles. A step the CLI cannot take from a server throws an error that tells the user what to do; the route answers 501 with its message. `status()` never returns or logs what the CLI printed about credentials. `loginCommand` is what a user runs in a terminal to sign in (`claude auth login`, `codex login`, `agy`); the model picker shows it for an engine that is signed out. |
| `createProcess(options)` | Returns an engine process. `options` holds `sessionId`, `cwd`, `model`, `effort`, `permissionMode`, `resume` (true when an earlier turn of the session was answered, so the CLI has a conversation to continue), `engineState` and `toolServer` (`{ name, url, token }` or `undefined`; see *Tool server*). |

An engine process is an `EventEmitter` with `isAlive`, `start()`, `sendUserMessage(text)`, `respondPermission(requestId, 'allow' | 'deny')` and `abort()`, plus `setPermissionMode(mode)` (a promise that rejects when the CLI refuses) when the adapter lists `livePermissionModes`. It emits:

| Event | Payload |
|---|---|
| `reasoning.delta` | `{ text }`. Deltas in a row form one reasoning part; text or a tool call in between starts the next part. |
| `text.delta` | `{ text }`. Deltas in a row form one text part; reasoning or a tool call in between starts the next part. |
| `tool.started` | `{ id, name, input }`, as soon as the CLI starts a call |
| `tool.called` | `{ id, name, input }` once the input is final and the call runs. A CLI that reports a call only whole sends this without `tool.started`. |
| `tool.completed` | `{ id, output, isError }`: the result as text, and whether the CLI calls it a failure |
| `prompt.merged` | No payload. The CLI took the next queued prompt into the running turn, and that turn's `turn.completed` answers both. |
| `permission.requested` | `{ requestId, toolName, input, summary }` |
| `turn.completed` | `{ outcome: 'succeeded' \| 'failed', usage, error? }`, with `usage` as `{ input, output, reasoning, cacheRead, cacheWrite, total? }` and `error` as `{ type, message }` on a failed turn. The five counts add up every model call of the turn and must not overlap. `total` is the context the turn ended with: what its last model call read and wrote. The context meter reads `total`; without it the UI adds up the five counts, and that sum grows with every tool call, because each call re-reads the whole conversation. An adapter that cannot tell leaves `total` out. |
| `engine.state` | A JSON object the CLI needs to resume this session later, such as its own conversation id. The runtime stores it as the session's `engineState` and passes it to the next `createProcess`. |
| `error`, `exit` | The process failed or ended. |

## Invariants

- Every event on the stream carries an `id` (`stream-hub.js` adds one). The UI drops a wire event without it, which once hid every engine event from the session list, the live status and the unread and failed marks.
- `session.created` names the session's engine (`agent`) and `model`; deleting a session sends `session.deleted`. Other clients learn about new and removed sessions from these.
- A session created without a title has no `title`, in the store, in the session record and in `session.created`. OpenCode's `title` is optional, and each client shows its own word for an untitled session in the user's language. Sessions created before 2026-10-17 got `Yeni Sohbet` as a default title. They keep it, because nothing in the record tells that default from a title the user typed.
- The model picker lists every engine's models. Picking another engine's model (`POST /api/session/:id/model`) moves a chat with no messages and no running turn to that engine, with that engine's default effort and permission mode. A chat with history answers 409 and stays put, because a CLI cannot resume another CLI's transcript. `PATCH` ignores `engine`.
- A session starts on the engine it names, else on the engine of the model it is created with (`model.providerID`), else on the default engine, with the model's `variant` as its effort. The composer creates a draft's session this way, so its first send switches nothing.
- The session's wire `model` carries its effort as `variant` when that effort is not the model's default, as an OpenCode record does, so the composer shows the effort the session runs on.
- A stored session without `engine` belongs to the default engine. Those are sessions from before engines existed.
- Only the runtime writes `engineState`. `PATCH` ignores it, so a client cannot point a session at another CLI conversation. It survives a server restart because it is stored with the session. An adapter validates it before use and starts a new conversation when it is missing or invalid.
- A session whose engine is no longer registered stays on disk. Listing skips it and opening it returns 409.
- Each prompt gets its own assistant message. A CLI answers prompts in order, so events go to the oldest unfinished turn. A prompt the CLI took into the running turn (`prompt.merged`) gets none: its turn is dropped from the queue, because waiting for a `turn.completed` that never comes would keep the session busy and give every later answer to the wrong prompt.
- An assistant message shows text, reasoning and tool calls in the order the CLI produced them, live and after a reload. Each run of text deltas is its own text part: `session.text.started`, `session.text.delta` and `session.text.ended` with the run's `ordinal`, counted from 0 per message. A run ends when reasoning or a tool call comes next, or when the turn ends. Reasoning runs work the same way with `session.reasoning.*` and their own count. An empty delta starts nothing.
- A tool call becomes `session.tool.input.started`, `session.tool.called` and `session.tool.success` or `session.tool.failed` on the wire, and a tool part in the stored message. A call that ran (`tool.called`) and is still open when its turn ends fails with "The turn ended before this tool finished", so no client shows it running, or a page waiting, forever. A call that was only started is left as it was and not stored, because some adapters report nothing more about a call and failing it would mark work that succeeded.
- When the process exits or fails mid-turn, every queued turn ends as `failed` and its partial text is still stored. Abort ends them as `interrupted`.
- Live status uses OpenCode 2.x execution events only: `session.execution.started` when a prompt is accepted, then exactly one of `session.execution.succeeded`, `session.execution.failed` (with `error: { type, message }`) or `session.execution.interrupted` (`reason: 'user'`) once the session's queue drains. The UI marks a session running and failed from these, and the host's `/api/sessions/status` map reads them from the same stream. Every path that ends a turn sends one, a process that never started included. `/api/session/active` lists the sessions with an open turn; a CLI process stays alive between turns, so a live process alone is not a running session. The engine never sends `session.idle`: OpenCode's `session.idle` carries no outcome, so a failure sent that way read as a success.
- Claude Code reports an API failure as a `success` result with `is_error` set; the adapter treats it as a failed turn and passes the CLI's result text as the error message.
- Permission replies from the UI arrive as OpenCode's `once`, `always` or `reject`. `once` and `always` allow the call, `reject` denies it. Nothing is remembered across calls yet.
- A permission `requestId` is unique across every session, because the control bridge keys pending prompts by it alone. An engine whose CLI numbers its own requests per process maps them to a UUID.
- `GET /api/config` answers a bare list of config entries, as OpenCode 2.x does: one document whose `model` is the default engine's `provider/model`. The client folds that list for every directory it bootstraps, so a `data` envelope there failed the bootstrap of every directory, Chats included ("Could not initialize workspace").
- In enterprise mode both sign-in routes answer 403 with `code: 'enterprise_mode'` for every engine, before the adapter runs: signing in to a model provider through this server is what the mode closes. Signing out still works. `GET /api/engines/readiness` then gives a signed-out engine no `fixCommand`, so the model picker shows no sign-in command either (*Catalog*). Both read the policy at each request.
- A prompt's user message keeps the `id` the client sent with it, so the UI's optimistic copy of the prompt is the stored message. An `id` that is not `msg_` followed by letters and digits answers 400 `InvalidRequestError`, and one the session already has answers 409 `ConflictError`. Without one the runtime mints an id. The runtime mints ids in OpenCode's ascending format, as the UI does, because the chat breaks a tie in creation time by id.

## Session settings

A session's model, effort and permission mode are stored on its record. `PATCH /api/session/:id` and `PATCH /api/sessions/:id` check each one against the session's engine before anything is stored: a model the engine does not list, an effort the model does not offer, or a permission mode the engine does not have answers 400 with the `field` it refused (`InvalidRequestError` on the singular route). An effort for a model that offers none is left out. A session that does not exist answers 404. Creating a session checks the same fields.

The CLI reads its settings when its process starts, and the runtime keeps each process alive between turns. A changed setting reaches the CLI this way:

- **Permission mode, live.** The PATCH hands it to the running process when the adapter lists it in `livePermissionModes` (`applyPermissionMode` in `session-runtime.js`). Claude switches at once, during a turn too, through the stream-json `set_permission_mode` control request an SDK host sends. Claude Code 2.1.302 takes every mode this way except `bypassPermissions`, which it refuses (`bypass_not_launched`) for a process not launched in it.
- **Everything else, at the next prompt.** A prompt whose model, effort or permission mode differs from the live process's replaces that process when it has no open turn: the old one stops without an event, and the new one resumes the conversation (`--resume`, `thread/resume`, `--conversation`). A process still answering a turn keeps its settings until its queue drains, so a prompt it takes into that turn runs on the old ones. A live switch the CLI refused leaves the old mode on the process, so the next prompt replaces it the same way.

`GET /api/engines/controls` tells the composer which modes switch live (*Catalog*).

## History

`GET /api/session/:id/message` and `GET /api/session/:id/message/:messageID` serve a chat's history as the OpenCode 2.x records `@opencode/client` returns and the UI projects (`packages/ui/src/lib/opencode/projection.ts`). A reload draws the chat from them, so they must give the same messages and parts the live events drew.

**Records.** A user message is `SessionMessageUser`: `{ id, time: { created }, type: 'user', text }`. An assistant message is `SessionMessageAssistant`: `{ id, time: { created, completed }, type: 'assistant', agent, model: { providerID, id }, content, finish, cost, tokens }`. `content` holds `{ type: 'text', text }`, `{ type: 'reasoning', text, time }` and `SessionMessageAssistantTool` items: `{ type: 'tool', id, name, executed, state, time: { created, ran, completed } }`. A tool `state` is `completed` with the result as text `content` and the call's `metadata` (`metadata.openchamber` for pages), `error` with `{ type: 'tool', message }` and the result text when there is one, `running` with `metadata: {}`, or `streaming` for a call only started.

**Ids line up with the live stream.** The UI derives part ids from content position: the n-th text item of a message is `<messageID>:text:<n>`, the n-th reasoning item `<messageID>:reasoning:<n>`, a tool item its call id. The stored message keeps the turn's parts in stream order, one per run of text or reasoning, so the run streamed with ordinal n is the n-th item of its type read back. The translator never stores an empty run, because the history leaves empty text out and that would shift the count of every later item. A call that was only started is left out at the end of the turn, which shifts nothing, since a tool item goes by its call id. The assistant message id is the `assistantMessageID` of the turn's events, the user message id the `inboxID` of `session.inbox.enqueued`, and both carry the same creation time as their event. A record stored before runs were split holds at most one text and one reasoning part, each where its first delta arrived, and still reads that way.

**What is stored.** The translator stores an assistant message with `createdAt` (when `session.step.started` went out), `completedAt`, `outcome` (`succeeded`, `failed` or `interrupted`), `tokens` and its parts. `tokens` is what `session.step.ended` carried: the turn's counts, plus `total` when the adapter reported one. Reasoning parts keep `time: { created, completed }`, tool parts `executed` and `time: { created, ran, completed }`. The outcome reads as `finish`: `stop`, `error` or `unknown`, the same value `session.step.ended` carries. Records stored before these fields existed still read: a missing completion is the creation time, a missing outcome reads as `stop`, a part without times takes the message's, and text kept under `content` (the plural routes) is read from there. A message or part that cannot be read is left out and the rest of the history still loads.

**Running turns.** The store gets a turn's message when the turn ends. Until then the history adds the turn's current state from the runtime (`openMessages`), without `time.completed`, `finish`, `cost` or `tokens`, and with calls still running or only started. A reload during a turn keeps it on screen, including a page that waits for the user's answer, and later events continue it. The message moves to the store in the same tick its turn leaves the runtime, so a read never lists it twice.

**Paging.** The list honours `limit`, `order` and `cursor`, and `type` as a filter. Messages are ordered by creation time, a tie in the stored order. The default is newest first. `cursor.next` continues after the page's last message in the same order and is null once nothing remains; `cursor.previous` is always null, because no client walks back. A cursor names its order, so combining it with `order` answers 400 `InvalidRequestError`, as OpenCode does. A cursor that names no message of the history answers 400 `InvalidCursorError`, and a malformed query 400 `InvalidRequestError`. A missing message on the single-message route answers 404 `MessageNotFoundError`.

**Contract test.** `history.test.js` records a page in `test/history-page.json` (rewrite it with `vitest -u` after a deliberate change). `packages/ui/src/lib/opencode/client.test.ts` feeds that file through the real client and projection and checks the parts the live stream would have drawn.

## Catalog

The composer's model picker, its reasoning picker and the MCP lists read OpenCode 2.x routes through `@opencode/client` (`getProvidersForConfig`, `listMcpServers` in `packages/ui/src/lib/opencode/client.ts`). `catalog.js` builds the records from the adapters, so the adapter's `modelCatalog()` is the only source. Every answer carries `location: { directory }`, the directory of the `x-opencode-directory` header. No engine's catalog depends on the directory.

| Route | Answer |
|---|---|
| `GET /api/model` | `{ location, data: ModelInfo[] }`, every model of every engine in registry order |
| `GET /api/model/default` | `{ location, data: ModelInfo }`, the default engine's `defaultModel`, the model `/api/config` names |
| `GET /api/provider` | `{ location, data: ProviderInfo[] }`, one provider per engine |
| `GET /api/mcp` | `{ location, data: McpServer[] }`, OpenChamber's tool server when one is wired |

**Models.** A model reads as `{ id, modelID, providerID, family, name, capabilities, variants, time, cost, status, enabled, limit }`.

- `id` and `modelID` are the adapter's model id, `providerID` the adapter's. Picking the model sends that pair to `POST /api/session/:id/model`.
- `variants` are the model's `efforts`, else the adapter's, as `{ id }`. The reasoning picker sends the chosen one as `variant`, which the session model route stores as the effort. Antigravity's `default` model passes no `--effort` and lists none.
- `capabilities` is `{ tools: true, input: ['text'], output: ['text'] }` for every model. A prompt reaches the CLI as text only, so no model claims an attachment, and the composer offers none.
- `limit` is the adapter's `limit`, with any size it leaves out taken from `{ context: 200_000, output: 32_000 }`. Those are below the sizes of every model the engines list, so the context meter never shows more room than a model has. A 0 cannot stand for unknown, because the model picker prints it as the size. Each engine's sizes and their source follow the list.
- `cost` is empty. The CLI bills its own account, and a zero price would show the model as free. `time.released` is 0, `status` `active` and `enabled` true.

| Engine | `limit` | Source |
|---|---|---|
| Claude Code | 1M context, 128K output | Claude Code 2.1.301 resolves the aliases to claude-sonnet-5-5, claude-opus-5-5 and claude-haiku-5-5, and its own model table gives each a native 1M window and 128K output tokens. |
| Codex | 272K context, 32K output | The model catalog bundled with codex-cli 0.163.0 gives every listed model a 272K context window and no output cap. `model/list` names neither, so the sizes stay fixed while the list is read from the CLI. |
| Antigravity | 200K context, 32K output | agy states no sizes. |

**Providers.** A provider reads as `{ id: providerID, name: displayName, activation, package: 'openchamber/engine/<id>' }`. `activation` is `enabled` when the engine's CLI is installed and signed in and `auto` otherwise, which includes a CLI that is missing and one not checked yet. The UI lists both the same way, so every engine stays in the picker. `disabled` is never sent. In OpenCode it is the user's off switch, and the UI hides such a provider.

**Controls.** `GET /api/engines/controls` answers `{ data: [{ engine, providerID, defaultPermissionMode, permissionModes, defaultEffort }], default }`, one entry per engine in registry order, built from the adapters without running a CLI. Each permission mode is `{ id, labelKey, descriptionKey, dangerous, appliesLive }`: `labelKey` and `descriptionKey` are the UI message keys `engine.permissionMode.<engine>.<mode>.label` and `.description`, which the UI translates; `dangerous` comes from `dangerousPermissionModes` and `appliesLive` from `livePermissionModes`. `defaultEffort` is the adapter's, or null. The composer's Permission and Effort controls read it through `useEngineControlsStore` (`packages/ui/src/stores`); a 404 there means a server without engines.

**Readiness.** `GET /api/engines/readiness` answers `{ data: [{ engine, providerID, state, fixCommand }] }`, one entry per engine in registry order. `state` is `ready`, `not-installed`, `signed-out`, or `unknown` for an engine not checked yet or whose check threw. `fixCommand` is the installer's `installCommand` for `not-installed`, the adapter's `auth.loginCommand` for `signed-out`, and `null` otherwise. In enterprise mode it is `null` for `signed-out` too, because the mode closes signing in to a model provider through OpenChamber; the route reads the policy at each request. The install command stays in enterprise mode: installing a CLI adds no provider, key or endpoint, and the CLI still needs the sign-in the mode refuses. Nothing the CLI reported about the account is in the answer. The composer's model picker greys out the models of a `not-installed` or `signed-out` engine, names the reason on the provider's header and, when there is one, shows `fixCommand` with a copy button; an `unknown` engine stays selectable, so nothing is greyed out before the first check. The UI reads it through `useEngineReadinessStore` (`packages/ui/src/stores`). A prompt to an engine whose CLI cannot run still fails with the error from starting or running it.

Neither route waits for a CLI. `createEngineAvailability` answers the last known state and, when that is missing or stale, checks after the response went out: `installer.getStatus()` first, which can spawn the CLI synchronously, then `auth.status()` when the CLI is installed. A `ready` state is stale after 30 seconds, any other after 5, so an engine the user just installed or signed in to is offered again the next time the picker opens. One check runs per engine at a time. The first read after a start therefore answers `auto` and `unknown` for every engine. The UI renders `enabled` and `auto` alike, so the server sends no catalog event when a check changes one.

**MCP.** Each CLI loads the MCP servers of its own configuration, and OpenChamber adds only its tool server to each process (*Tool server*). The list names that server, `{ name: 'openchamber', status: { status: 'connected' } }`, while a `toolServer` provider is wired, and is empty otherwise. Antigravity does not load the tool server yet, which the list does not show. Connecting the tool server answers 204 and changes nothing. Connecting or disconnecting any server, `PUT` and `DELETE` on `/api/experimental/mcp/:server`, and disconnecting the tool server answer 400 `InvalidRequestError` with a message that says what to do instead. The status is 400 because the client keeps the body only of a status the route declares, and those routes declare 400, 401 and 404, so a 501 would have reached the UI as "unexpected status".

**Contract test.** `catalog.test.js` checks each answer against strict zod restatements of `ModelListOutput`, `ModelDefaultOutput`, `ProviderListOutput` and `McpListOutput` from the client's generated types, and records the answers in `test/catalog-responses.json` (rewrite it with `vitest -u` after a deliberate change). `packages/ui/src/lib/opencode/client.test.ts` feeds that file through the real client and checks the providers, models, variants and the MCP error the UI gets.

## Session summary

`GET /api/sessions/summary` answers `{ sessions }`, one row per listed session: `{ id, parentID?, title, directory, engine, updatedAt, state, outcome?, chat? }`. `chat: true` marks a session of the managed Chats: its folder is inside one of the chats roots the server passes in (`chatRoots`, the default `chats` folder and `OPENCHAMBER_CHATS_DIR`), so a watching window lists it under Chats instead of as a folder of its own. `GET /api/sessions/summary/stream` is SSE: a `{ type: 'snapshot', sessions }` event first, then `{ type: 'session', session }` whenever a session's state, pending request or title changes, `{ type: 'removed', id }` when one is deleted, and a `: heartbeat` comment every 15 seconds. Both are registered before `/api/sessions/:id` and sit behind the UI auth gate like every route here. Neither carries message content. The client is `packages/ui/src/lib/hosts/`.

`state` is read from the owner of each fact when a row is built:

| State | Source |
|---|---|
| `waiting-permission` | The control bridge holds an unanswered request for the session. |
| `running` | The runtime has a prompt queued or being answered (`isTurnActive`). A live process between turns is not running. |
| `failed` | The last finished turn failed and no new one started. |
| `idle` | Anything else. |

`waiting-input` is part of the contract for engines that ask questions; no engine asks one yet. `outcome` is the last finished turn's `succeeded`, `failed` or `interrupted`, kept in memory only, so after a restart every session reads `idle` without one.

The runtime announces each turn start and end (`subscribeActivity`), the control bridge each change to a session's pending requests (`subscribe`), including the silent timeout, and the routes announce creation, title edits, an engine switch from the model picker and deletion. A notification that leaves the row unchanged sends nothing.

## Adding a CLI

1. Create `<engine>/adapter.js` with a factory returning the adapter above. Keep binary discovery and spawning in `<engine>/platform.js`, like `claude/`. A CLI published on npm passes its binary name and install paths to `cli-platform.js` and its package name to `cli-installer.js`, as `claude/` and `codex/` do.
2. Map the CLI's own output to the engine events. Drop events the UI cannot show yet, do not invent wire events.
3. If the CLI picks its own session id, emit it with `engine.state` and read it back from `options.engineState`.
4. If the CLI can call an MCP server over HTTP, give it `options.toolServer` (*Tool server*).
5. Register the factory in `packages/web/server/index.js`, after Claude so Claude stays the default.
6. Add a test with the CLI's recorded output. `test/fake-engine.js` shows the process shape the runtime expects.

## Tool server

OpenChamber's own agent tools (the in-app browser, render page, project knowledge, session control, notify; `../agent-tool/DOCUMENTATION.md`) reach every engine as one MCP server over HTTP. The engine never sees how they are served: `routes.js` takes an optional `toolServer` provider, `{ name, grant, describeResult }`, which `index.js` wires to the agent-tool runtime's `engineToolServer`. `name` is the server's MCP name, `openchamber`, which the MCP list shows (*Catalog*).

**Lifecycle.** When the runtime starts a CLI process it asks `toolServer.grant({ sessionId, directory })` for a grant and passes its `server`, `{ name, url, token }`, to `createProcess` as `options.toolServer`. The token is fresh for each process, and the server binds it to that session and directory on its side, so a call cannot name another session. When the process ends, for any reason, the runtime revokes the grant: the token stops working and its running calls are aborted. A prompt for a live process calls the grant's `noteUserMessage()`, which ends a page waiting for the user's answer so the CLI does not hold the message behind it. A grant that fails, such as before the listener has a port, leaves the session running without the tools and logs why. Without a provider (tests, or a server that does not wire one) `options.toolServer` is `undefined`.

**What an adapter does with `options.toolServer`.**

1. Register an HTTP (Streamable HTTP) MCP server named `name` at `url`, sending `Authorization: Bearer <token>`. Keep the token out of argv, which `ps` shows every user: a private file, the CLI's stdin, or an environment variable the CLI reads, in that order of preference.
2. Spawn with `toolServerEnvironment(url)` from `tool-server.js` as the child's environment. It is the whole environment with the server's host added to `NO_PROXY`, so a proxy never receives the token.
3. Let the tools run without a permission prompt. Their limits are enforced on the OpenChamber side (the settings that switch each tool off, a fixed action allowlist, nothing destructive), and a prompt for every browser click makes them unusable.
4. Report the server's tools by their own names (`openchamber_render`, not the CLI's namespaced form). The chat renders them by those names.
5. Emit `tool.called` and `tool.completed` for them. The runtime asks the provider's `describeResult(name, output)` for the metadata the chat draws a page from.
6. If the CLI can put its own tool call id in the MCP request's `_meta`, add that key to `CALL_ID_META_KEYS` in `../agent-tool/mcp-server.js`. A page can wait for the user's answer only then, because the chat answers by the call id it shows; otherwise the agent is told to ask in text.
7. If the CLI takes a prompt that arrives mid-turn into the running turn, emit `prompt.merged` when it does.

**Claude Code.** `claude/mcp-config.js` writes `{"mcpServers":{"openchamber":{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}}}` into a file of its own: a fresh `mkdtemp` directory (0700) with one file written 0600, removed when the process exits or fails to spawn. `--mcp-config <file>` names it, so the token is neither in argv nor in the environment the agent's shell commands inherit. `--strict-mcp-config` is not passed, so the user's own MCP servers still load. `--allowedTools mcp__openchamber__*` pre-allows the tools: `dontAsk` would otherwise deny them, `auto` would leave each call to its classifier, and `manual` would ask for every browser action; a deny rule in the user's own settings still wins. Claude defers MCP tools behind its tool search unless a tool asks to load up front, which the server does unless Code Mode is on. Claude names the tools `mcp__openchamber__<tool>`; the adapter strips that prefix. Every `tools/call` carries `_meta["claudecode/toolUseId"]`, the id of the tool part in the chat, so pages can wait. Claude takes a prompt that arrives mid-turn into the running turn at its next tool boundary and answers both with one `result`; with `--replay-user-messages` it echoes each prompt when it takes it, and the adapter emits `prompt.merged` for an echo that arrives while a turn is open. Checked against Claude Code 2.1.301.

**Codex.** `thread/start` and `thread/resume` carry `config.mcp_servers.<name>` with the `url`, `bearer_token_env_var: "OPENCHAMBER_MCP_TOKEN"` and `default_tools_approval_mode: "approve"`, and the token is in that variable of the app-server's environment, never on the stdin channel, so Codex does not write it into the thread it stores. The name matches Codex's default shell-environment excludes (`*KEY*`, `*TOKEN*`), which keep it out of the commands Codex runs while `shell_environment_policy.ignore_default_excludes` is off. Checked against codex-cli 0.163.0 without a signed-in account: `thread/start` accepts the config, Codex connects at once, sends the bearer from the variable and lists the tools. Not checked: whether the excludes are on by default, whether `approve` keeps every call from asking, and whether Codex sends its call id in `_meta` (the `tools/list` request carried only a progress token, so its pages probably cannot wait yet). `item/started` of an `mcpToolCall` gives `tool.started` and `tool.called`, since its arguments are already final, and `item/completed` gives `tool.completed`.

**Antigravity.** Not wired. Headless `agy` has no host permission channel, and whether it loads an MCP server from a flag or a per-run config is not verified. When it can, it follows the steps above; its refusals in headless mode mean step 3 needs an allow rule for the server's tools.

## The Antigravity adapter

`antigravity/` drives Google's Antigravity CLI. Facts checked 2026-10-16 against agy's changelog up to 1.4.0 and the public captures listed at the end.

**Process.** One long-lived `agy --input-format stream-json --output-format stream-json` per session, available since agy 1.1.15. Each stdin line `{"event":"user","message":{"content":"..."}}` runs one turn of the same conversation. agy prints an `init` event, `step_update` events and one `result` per turn, and keeps running after the `result`. Its docs say to wait for the `result` before writing the next prompt, so `AgyProcess` queues prompts and writes one at a time.

**Resume.** agy picks the conversation id and reports it in `init.conversation_id`. The process emits it as `engine.state` `{ conversationId }` and passes it back as `--conversation <id>` in the next process. When agy cannot find that conversation it starts a new one; the new id replaces the stored one and earlier context is lost to the CLI, while OpenChamber keeps its stored messages.

**Events.**

| agy output | Engine event |
|---|---|
| `step_update` with `step_type: agent_response` and `text_delta` | `text.delta` |
| first `step_update` of a `step_type: tool` step | `tool.started` with `tool_name` and `tool_info.parameters` |
| `result` with `status: SUCCESS` | `turn.completed` `succeeded` |
| `result` with any other status, an `AGY_ERROR:` line on stderr during the turn, or an exit mid-turn | `turn.completed` `failed` |
| `user_input` and `system_message` steps, `command_result`, `subagent_info` | dropped |

agy streams no reasoning text, only `thinking_tokens`, so there is no `reasoning.delta`. It has no host approval channel either, so the process never emits `permission.requested` and `respondPermission` throws.

**Usage.** Each `agent_response` step carries `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }` for its own model call, where input includes cache reads and output includes thinking. A turn's usage is the sum over its steps, with cache reads taken out of `input` and thinking out of `output`. Its `total` is the input plus output of the turn's last step with usage. The `result` usage is a running total for the whole conversation, so it is not used.

**Permission modes.** Headless agy refuses, without asking, every tool the mode does not allow, and the agent sees the refusal. Allow rules in agy's own `settings.json` apply in every mode.

| Mode | Flag | Lets agy |
|---|---|---|
| `default` | none | read the workspace; edits and commands are refused |
| `accept-edits` | `--mode accept-edits` | also edit files; commands still need an allow rule |
| `auto` | `--mode auto` | also run commands it judges safe; refuses irreversible actions. Linux and macOS only, agy 1.3.5 and later |
| `dangerously-skip-permissions` | `--dangerously-skip-permissions` | run every tool |

`plan` is left out because a headless run approves its own plan and goes on to edit files, and issue 1181 reports writes in plan mode.

**Models.** `default` passes no `--model` and keeps the CLI's saved model and effort. Any other model passes `--model` and `--effort`. The list in `adapter.js` is short on purpose, because `agy models` shows what the signed-in account can use and that differs per account.

**Install.** agy ships through an install script, which puts a native binary in `~/.local/bin/agy` or `%LOCALAPPDATA%\agy\bin\agy.exe`. The installer reports `canInstall: false` with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or `irm https://antigravity.google/cli/install.ps1 | iex` on Windows. The npm packages named `agy` and `antigravity-cli` are placeholders from other publishers.

**Sign-in.** `auth.status()` runs `agy models` and reports signed in when it lists a model; agy lists nothing without an account. It never reads stderr or credential files. agy signs in and out only inside its terminal UI, so `login()` and `logout()` throw the step to take there.

**Not verified against a live agy:** whether `init` repeats on every turn, whether a prompt that is a slash command such as `/usage` ends with a `result`, and the fields of the `AGY_ERROR` line, of which only the prefix is read.

Sources: the [agy changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md); [issue 1181](https://github.com/google-antigravity/antigravity-cli/issues/1181) for the stdin line and plan mode; a live 1.1.22 capture in `adapter/agy/testdata` of [RandomCodeSpace/aiusage](https://github.com/RandomCodeSpace/aiusage) for usage totals; `src-tauri/src/antigravity_stream.rs` in [Lume](https://github.com/Lume-agents/Lume) and `tests/unit/agy-stream-parser.test.js` in [RTS-Agents](https://github.com/AJFrio/RTS-Agents) for step and tool fields; the headless docs at antigravity.google/docs/cli/headless.

## The Codex adapter

`codex/` drives OpenAI's Codex CLI through `codex app-server`. It is written against the schema that codex-cli 0.163.0 generates with `codex app-server generate-json-schema --out <dir>`. After a Codex upgrade, regenerate the schema and compare it with `codex/protocol.js`.

**Process.** One `codex app-server` per session speaks JSON-RPC 2.0 over stdio: one JSON message per line, without the `jsonrpc` field. `CodexProcess` sends `initialize` with `clientInfo.name` set to `openchamber`, then the `initialized` notification, then `thread/start` with the session's `cwd`, `model`, `approvalPolicy` and `sandbox`, and the tool server's `config` when there is one (*Tool server*). Each prompt is a `turn/start` with the text and the reasoning `effort`. Codex runs one turn per thread at a time, so later prompts wait in the process until `turn/completed`. `codex exec --json` prints whole messages only, so it cannot stream text.

**Resume.** Codex writes a thread to disk with its first turn, and `thread/resume` on a thread without one answers "no rollout found". The process emits `engine.state` `{ threadId }` once Codex accepts a turn, and the next process calls `thread/resume` with that id and `excludeTurns: true`. When Codex answers "no rollout found", for example after `~/.codex/sessions` was cleared or under another `CODEX_HOME`, the process starts a new thread and stores its id. Earlier context is then lost to the CLI, while OpenChamber keeps its stored messages. Any other resume error fails the prompt.

**Events.**

| Codex message | Engine event |
|---|---|
| `item/agentMessage/delta` | `text.delta`; a blank line separates two agent messages that follow each other directly. A tool call or reasoning between them already makes them separate parts. |
| `item/reasoning/summaryTextDelta` | `reasoning.delta`; a blank line separates two summary parts that follow each other directly |
| `item/started` with a `commandExecution` item | `tool.started` named `shell`, input `{ command, cwd }` |
| `item/started` with a `fileChange` item | `tool.started` named `edit`, input `{ changes: [{ path, kind }] }` |
| `item/started` with an `mcpToolCall` item | `tool.started` and `tool.called` named `mcp__<server>__<tool>` (the tool server's own tools by their own names), input the call arguments |
| `item/completed` with an `mcpToolCall` item | `tool.completed` with the result's text, or the error message when the status is not `completed` |
| server request `item/commandExecution/requestApproval` | `permission.requested` with tool `shell` and `{ command, cwd, reason }` |
| server request `item/fileChange/requestApproval` | `permission.requested` with tool `edit` and the paths and diffs of that item |
| `thread/tokenUsage/updated` | the usage of the next `turn.completed` |
| `turn/completed` with status `completed` | `turn.completed` `succeeded` |
| `turn/completed` with status `failed` or `interrupted`, or a rejected `turn/start` | `turn.completed` `failed` |
| `item/reasoning/textDelta`, `error`, `warning`, thread status, `item/completed` of other items, output deltas and every other method | dropped |

Codex sends raw reasoning text only with its `show_raw_agent_reasoning` setting, next to the summary, so reading the summary alone keeps reasoning from showing twice. An `error` notification with `willRetry: false` is followed by `turn/completed` with status `failed`, which ends the turn. Notifications from other threads, such as sub-agents, are dropped.

**Approvals.** Codex numbers its server requests per process, so each approval gets a UUID as `requestId`. `allow` answers `{ decision: "accept" }`. `deny` answers `{ decision: "decline" }`, and Codex goes on with the turn without the action. When Codex sends `serverRequest/resolved` first, a later reply is dropped. Every other server request, such as `item/tool/requestUserInput` or an MCP elicitation, gets a JSON-RPC error so Codex does not wait on it.

**Usage.** `thread/tokenUsage/updated` carries the thread's running `total` and the `last` model response, and Codex may send the same numbers twice. A turn's usage is how far `total` grew during the turn. On a resumed thread, `total` minus `last` of the turn's first report is the starting point. Codex counts cache reads and cache writes inside `inputTokens` and reasoning inside `outputTokens`, so the adapter takes them out to keep the five counts apart. The turn's `total` is `inputTokens` plus `outputTokens` of its last report's `last`.

**Permission modes.** Each mode sets Codex's approval policy and sandbox on `thread/start` and `thread/resume`. The control bridge asks the user for every Codex approval, because Codex asks only when its policy says so. `on-request` is the default.

| Mode | `approvalPolicy` | `sandbox` | What Codex does |
|---|---|---|---|
| `read-only` | `on-request` | `read-only` | reads anything; asks before a write or a command that needs more |
| `untrusted` | `untrusted` | `workspace-write` | asks before every command except reads it knows to be safe |
| `on-request` | `on-request` | `workspace-write` | Codex's own default: works inside the workspace and asks to go beyond it, such as for network access |
| `never` | `never` | `workspace-write` | never asks; whatever the sandbox blocks fails and Codex is told |

No mode passes `danger-full-access`.

**Models.** `codex/model-catalog.js` reads the models from the installed CLI: it starts `codex app-server` in the home folder, sends `initialize`, `initialized` and `model/list` (following `nextCursor` to the last page), and stops the process. `model/list` answers without a signed-in account. Each model's id is the `model` it reports, which `thread/start` takes, its name the `displayName`, and its efforts the `supportedReasoningEfforts`; the default is the model with `isDefault`. A model entry that does not parse is left out and the others are kept. codex-cli 0.163.0 lists eight models, `gpt-6.1-sol` the default; most offer `max` and `ultra` beyond `low` to `xhigh`, `gpt-6-luna` and `gpt-5.6-luna` stop at `max` and `gpt-5.5` at `xhigh` (`test/codex/model-list.ndjson`). `model/list` names no context window, so `limit` stays fixed. OpenChamber keeps `medium` as the default effort, which every listed model offers; the CLI's own per-model default (`defaultReasoningEffort`) is not used.

The catalog never makes a request wait. The server starts the first read when it sets up the routes. Until a read succeeds, the catalog serves the fallback list in `model-catalog.js`, what 0.163.0 listed, with the four efforts every model there accepts; after that it serves the list of the last successful read. A failed read, an empty list or no answer within 15 seconds keeps what was served and logs a warning. Without the CLI nothing is read. Serving the catalog checks in the background, at most every 30 seconds, which `codex` binary and version the installer finds; a different one, or 10 minutes since the last read, starts a new read. One read runs at a time. A Codex installed while the server runs is read at the first check after it appears.

The model goes on `thread/start` and `thread/resume` and the effort on each `turn/start`. A change to either, or to the permission mode, reaches Codex with the next prompt, which replaces the idle process (*Session settings*). A model that disappears from a newer list is refused for new prompts, including those of a chat already on it, until the user picks another.

**Install.** `npm install -g @openai/codex`. On Windows the npm launcher is `codex.cmd` in `%APPDATA%\npm` and runs through `cmd.exe`. The launcher picks the native binary for the platform and puts its bundled tools on PATH, so the adapter always runs the launcher. On macOS and Linux the adapter checks `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin` and `~/.npm-global/bin`, then the login shell's PATH. The version comes from the package's `package.json` next to the launcher, or from `codex --version`.

**Sign-in.** `auth.status()` runs `codex login status`. Exit code 0 means signed in, and the line on stderr tells ChatGPT from an API key. That line ends in a masked key, so the adapter keeps only the method and never returns or logs the line. It never reads `auth.json`, since Codex can keep credentials in the OS keyring. `login()` starts `codex login` detached; it opens the browser and waits for the callback by itself. `logout()` runs `codex logout` and reports a failure with the step to take.

**Enterprise mode.** A Codex session sends its conversation to OpenAI, the session's own provider, the way a Claude session sends it to Anthropic. Signing in through this server is refused in enterprise mode, as for every engine, but a Codex the user signed in to from a terminal still runs. Whether enterprise mode should turn the Codex engine off entirely is a question for the maintainer.

**Not verified against a live, signed-in Codex:** a full turn, because Codex was not signed in where the adapter was written. The handshake, `model/list` (`test/codex/model-list.ndjson`), `thread/start`, `thread/resume` of a missing thread and a failing turn were recorded from codex-cli 0.163.0. The text, reasoning, tool, approval and usage messages in `test/codex/turn-with-tools.ndjson` were built from the generated schema and validated against it. Whether cache writes are part of `inputTokens` is assumed; OpenAI models report none.

## The Claude adapter

- Permission prompts use `--permission-prompt-tool stdio`, which sends each one as a `can_use_tool` control request. `--permission-prompts host` denies them silently in this mode, so `manual` never asked. A denial carries a message the agent reads.
- The permission mode switches in a running process through the `set_permission_mode` control request; Claude answers with a `control_response` (`success`, or `error` with the reason), which `ClaudeProcess.sendControlRequest` waits for up to 5 seconds. Claude reports `manual` back as `default`. What each mode does, as the composer describes it: `manual` asks before edits and commands, `acceptEdits` edits files without asking and asks before other commands, `plan` reads and plans without changing anything, `auto` lets Claude's classifier allow safe actions and block risky ones, `dontAsk` refuses every tool not allowed in the user's settings, and `bypassPermissions` runs every tool without asking.
- The `result` usage adds up every model call of the turn. Each call's final counts arrive in its `message_delta` stream event (from `--include-partial-messages`), and a count that event leaves null keeps the call's `message_start` value. The `assistant` messages carry only the counts from the call's start, before the output was written. The turn's `total` is input, cache read, cache write and output tokens of its last call. A subagent's calls name the call that runs them (`parent_tool_use_id`) and are left out. In a turn recorded with Claude Code 2.1.302 that read three files one at a time, the counts added up to 146,232 tokens and `total` was 36,705. A turn without a finished call reports no `total`.
- Claude keeps its transcript under OpenChamber's session id. It refuses `--session-id` for an id it already has and `--resume` for one it has never seen. The process emits `engine.state` `{ transcript: true }` on Claude's first `init`, and every later process passes `--resume`. Sessions stored before that flag existed resume when an earlier turn has a stored answer.

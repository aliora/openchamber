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
| `claude/` | The Claude Code adapter. |
| `antigravity/` | The Antigravity CLI (`agy`) adapter. |

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
| `installer` | `getStatus(force)`, `install()`, `getLogs()`, and `log` and `status` events. A CLI the server cannot install reports `canInstall: false` and the command to run as `installCommand`; the install route then answers 400 with that command. |
| `auth` | `status()`, `login()`, `logout()`. `login()` must not block the request. A step the CLI cannot take from a server throws an error that tells the user what to do; the route answers 501 with its message. |
| `createProcess(options)` | Returns an engine process. `options` holds `sessionId`, `cwd`, `model`, `effort`, `permissionMode`, `resume` and `engineState`. |

An engine process is an `EventEmitter` with `isAlive`, `start()`, `sendUserMessage(text)`, `respondPermission(requestId, 'allow' | 'deny')` and `abort()`. It emits:

| Event | Payload |
|---|---|
| `reasoning.delta` | `{ text }` |
| `text.delta` | `{ text }` |
| `tool.started` | `{ id, name, input }` |
| `permission.requested` | `{ requestId, toolName, input, summary }` |
| `turn.completed` | `{ outcome: 'succeeded' \| 'failed', usage }`, with `usage` as `{ input, output, reasoning, cacheRead, cacheWrite }`. The five counts must not overlap, because the UI adds them up for the total. |
| `engine.state` | A JSON object the CLI needs to resume this session later, such as its own conversation id. The runtime stores it as the session's `engineState` and passes it to the next `createProcess`. |
| `error`, `exit` | The process failed or ended. |

## Invariants

- A session's engine is fixed when it is created. `PATCH` ignores `engine`, because a CLI cannot resume another CLI's transcript.
- A stored session without `engine` belongs to the default engine. Those are sessions from before engines existed.
- Only the runtime writes `engineState`. `PATCH` ignores it, so a client cannot point a session at another CLI conversation. It survives a server restart because it is stored with the session. An adapter validates it before use and starts a new conversation when it is missing or invalid.
- A session whose engine is no longer registered stays on disk. Listing skips it and opening it returns 409.
- Each prompt gets its own assistant message. A CLI answers prompts in order, so events go to the oldest unfinished turn.
- When the process exits or fails mid-turn, every queued turn ends as `failed` and its partial text is still stored. Abort ends them as `interrupted`.
- Permission replies from the UI arrive as OpenCode's `once`, `always` or `reject`. `once` and `always` allow the call, `reject` denies it. Nothing is remembered across calls yet.

## Adding a CLI

1. Create `<engine>/adapter.js` with a factory returning the adapter above. Keep binary discovery and spawning in `<engine>/platform.js`, like `claude/`.
2. Map the CLI's own output to the engine events. Drop events the UI cannot show yet, do not invent wire events.
3. If the CLI picks its own session id, emit it with `engine.state` and read it back from `options.engineState`.
4. Register the factory in `packages/web/server/index.js`, after Claude so Claude stays the default.
5. Add a test with the CLI's recorded output. `test/fake-engine.js` shows the process shape the runtime expects.

Notes on the next candidate, checked 2026-10:

- **Codex.** `codex app-server` speaks JSON-RPC over stdio: `initialize`, then `thread/start` or `thread/resume`, then `turn/start`. It streams `item/*` notifications with deltas and sends approvals as server requests, which maps onto `permission.requested`. `codex exec --json` only emits whole messages, so it cannot drive live text. Generate the schema from the installed binary with `codex app-server generate-json-schema`.

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

**Usage.** Each `agent_response` step carries `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`, where input includes cache reads and output includes thinking. A turn's usage is the sum over its steps, with cache reads taken out of `input` and thinking out of `output`. The `result` usage is a running total for the whole conversation, so it is not used.

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

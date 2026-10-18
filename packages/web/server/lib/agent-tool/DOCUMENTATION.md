# Managed OpenChamber Agent Tool

## Purpose

This module exposes OpenChamber to agents as typed tools, delivered two ways:
as an OpenCode plugin (below), and as an MCP server the engine CLIs call
(*MCP delivery for engine CLIs*). Both serve the same tools, from the same
definitions, and run every call through the same `execute`. The tools are
split by intent, because controlling sessions and driving a page are separate
things the user can want independently:

- `openchamber` — projects, sessions, worktrees, scheduled tasks, and showing
  a file to the user (`file.open`). Enabled while the persisted
  `agentControlToolEnabled` setting is not `false`.
- `openchamber_web` — looking at and interacting with the page in OpenChamber's
  browser panel. Enabled while `agentWebToolEnabled` is not `false`.
- `openchamber_notify` — `notify.send`, a notification to the user through
  `lib/notifications/emit-route.js` (same limits and rate window as
  `POST /api/notifications/emit`). Off by default: enabled only while
  `agentNotifyToolEnabled` is `true`, and the control service refuses the
  action when the setting is off, so a stale plugin cannot keep paging.
- `openchamber_knowledge` — the project's Notes, Todos and Plans, the items of
  the Project knowledge panel (`knowledge.list`, `save`, `delete`, `show`,
  with `kind` naming note, todo or plan; plans are files, so list and save
  give their path and the agent reads and edits them with its own file tools;
  dispatched by
  `../openchamber-control/project-knowledge.js` into
  `../project-context/runtime.js`). On by default: enabled while
  `agentKnowledgeToolEnabled` is not `false`, and the control service refuses
  these actions when it is, so a stale plugin cannot keep writing. Writes are
  attributed to the session OpenCode reported, never to a payload field.
- `openchamber_render` — `render.page`, a widget the chat draws inline above
  the agent's answer, such as a chart, diagram or table. `widget_code` is an
  `<svg>`, an HTML fragment or a full page (`html` is the older name and still
  accepted), with an optional `title` and up to 4 `loading_messages`; a call
  without `action` runs `render.page`, so `{ widget_code }` alone works. The
  page travels in the call's input, which OpenCode stores and
  syncs, so the server keeps no copy: `../openchamber-control/render-page.js`
  only checks the input (`widget_code` at most 200,000 characters so the callback
  body stays under its 1 MB limit, `title` at most 120) and the setting.
  The frame's CSP lets scripts and styles load only from cdnjs.cloudflare.com,
  cdn.jsdelivr.net and unpkg.com, and the page's `sendPrompt(text)` sends text
  as the user's next message in the session, from a click only.
- `openchamber_render_guide` — `render.guide`, the design rules for those
  widgets (`../openchamber-control/render-guide.js`): core rules plus the
  requested `modules`. On and off with `openchamber_render`.
  On by default: enabled while `agentRenderToolEnabled` is not `false`, and the
  control service refuses the action when it is, so a stale plugin cannot
  keep drawing. When to draw (`RENDER_PAGE_WHEN`) is shared with the line
  every session carries (`../session-knowledge/DOCUMENTATION.md`, *When to
  draw a page*). The description lists the theme variables the chat injects
  (`packages/ui/src/components/chat/message/parts/htmlRender.ts`); change both
  together.
  With `awaitAnswer` the call waits for the user's answer on the page. The
  plugin sends the call id (`context.id`) with the callback so the server can
  find the waiting call when the chat answers it, and copies the answer into
  the call's metadata (`metadata.openchamber.answer`), so every client shows
  the page as answered. While the call waits, OpenCode holds any chat message
  for that session until the call returns, so the plugin registers a
  `session.prompt` hook: a prompt for the session, from any sender, aborts the
  waiting call, which returns `{ answered: false, reason: "chat" }`, and the
  agent reads the message next.

Which tools are on is one answer, `agentToolSelection(settings)` in
`runtime.js`; the plugin and the MCP endpoint both read it, so a tool switched
off is gone from both. `enabledToolSpecs` and `toolInputSchema` hold what the
model reads about each tool (name, description, actions, inputs), shared by the
plugin template and the MCP `tools/list`.

Both default to on, are toggled in Settings → General → OpenChamber Tools, and take
effect in the running OpenCode within a couple of seconds — OpenChamber rewrites
the managed config file OpenCode watches (see
`lib/opencode/managed-config-file.js`). Installs where the user's own
environment sets `OPENCODE_CONFIG` fall back to `OPENCODE_CONFIG_CONTENT` and
still need a restart for a toggle. Each tool carries only its own actions and
only the parameters those actions use, so turning one off removes its inputs
from the schema rather than leaving them visible. The plugin is injected only
when OpenChamber launches and owns the OpenCode process, and not at all when
both settings are `false`.

- Every tool is registered with `options: { codemode: false }`, so it is a
  direct tool in the model's tool list. OpenCode 2 otherwise puts plugin tools
  behind its Code Mode `execute` tool, where the model sees only a
  size-limited catalog; with a few large MCP servers ours dropped out of it and
  agents concluded the tool did not exist. `agentToolsCodeMode: true` (the
  "Run through Code Mode" checkbox in the same section, off by default) flips
  all of them to `codemode: true`.
- The plugin accepts the action's inputs either inside `parameters` or beside
  `action`, because models produce both shapes; an explicit `parameters` object
  wins on a conflict. Rejecting the flattened shape turned a call that plainly
  carried a `url` into "url is required", which reads as a broken tool rather
  than a malformed call.

## Runtime flow

1. The OpenChamber HTTP listener binds and publishes its authoritative port.
2. `materializePlugin()` writes the plugin under
   `<openchamber-data-dir>/agent-tool/` and returns its directory; the managed
   config layer lists that directory in `<data-dir>/opencode.managed.json` and
   rewrites the file whenever a tool setting changes.
3. `createChildEnv()` adds a random per-child token and the callback URL to the
   managed OpenCode child environment. They are present even while every tool
   is off, so a tool switched on later can call back without a restart. The URL
   points at loopback, except when the listener is bound to one concrete
   address (`--host <ip>`): that socket does not answer on loopback, so the URL
   uses the bound address instead.
4. The plugin calls `POST /api/openchamber/agent-tool` with its typed input and
   the session id OpenCode gives the tool; OpenChamber resolves the session's
   directory on its own side.
5. The route delegates the fixed action allowlist directly to the shared
   OpenChamber control service. The CLI uses the same service through its
   authenticated HTTP adapter, so Goal Mode ordering, CLI wait behavior,
   result delivery, partial-failure reporting, and scheduled-task contracts
   have one owner.
6. Each action definition owns a short presentation title and a separate
   agent-facing description. The generated schema uses the description to state
   required inputs or one non-obvious behavior, while completed calls use the
   short title in native tool metadata.

## MCP delivery for engine CLIs

The engine CLIs (Claude Code first; `../engine/DOCUMENTATION.md`, *Tool
server*) reach the same tools over MCP. `mcp-server.js` owns the protocol and
the credentials; everything else is `runtime.js`.

- **Endpoint.** `POST /api/openchamber/mcp`, MCP's Streamable HTTP transport
  answered with plain JSON: `initialize` (the client's protocol version when
  it is one of ours, else our newest), `ping`, `tools/list` and `tools/call`;
  a notification gets 202 and any other method -32601 (Claude Code first
  tries `server/discover` and falls back on that). There is no session id and
  no server stream: GET and DELETE answer 405. Requests are one JSON-RPC
  message each, parsed with zod.
- **Name.** `engineToolServer.name` is the server's MCP name, `openchamber`,
  the name each grant carries and the engine's MCP list shows.
- **Grants.** `engineToolServer.grant({ sessionId, directory })` mints a fresh
  random token for one engine process and binds it, on this side, to that
  session and its directory. The engine runtime asks for a grant when it
  starts a process and revokes it when the process ends; revoking aborts the
  calls the token still runs. The server keeps only the token's SHA-256, and
  looks a caller up by it, so nothing about a token leaks through comparison
  timing. Tokens are never logged, persisted or returned to the UI.
- **Session binding.** A call runs as the session its token belongs to:
  `execute` receives that session id and the grant's directory
  (`trustedDirectory`), never a session, directory or context field from the
  call's arguments. Knowledge writes are attributed to that session, browser
  actions are scoped to its tabs, and a page waits under it.
- **Same path as the plugin.** `tools/call` flattens the arguments the way the
  plugin does (inputs beside `action` or inside `parameters`, `parameters`
  winning), then calls `execute`, so action resolution, boolean checks,
  agent-only usage errors and the control service's own setting checks are
  the plugin's. The tool list is read again on every call: a tool the
  settings turned off after the CLI listed it is refused with -32602 and
  nothing runs. The result is the plugin's envelope as text content with
  `isError: false`, a refused action included (`ok: false`), so the chat
  treats a call alike on every engine; only protocol failures are errors.
- **Loaded up front.** Each tool carries `_meta["anthropic/alwaysLoad"]`:
  `true` unless `agentToolsCodeMode` is on. Claude Code otherwise defers MCP
  tools behind its tool search, which is what Code Mode does in OpenCode, and
  agents then concluded the tools did not exist. Other clients ignore the key.
- **Pages that wait.** The chat answers a page by its tool part's call id.
  Claude Code sends its own tool call id with every call
  (`_meta["claudecode/toolUseId"]`), the same id the chat shows, so the page
  waits under it. A CLI that sends no call id cannot wait; the action answers
  with a usage error telling the agent to ask in text. When the user writes in
  the chat while a page waits, the engine runtime calls the grant's
  `noteUserMessage()`, and the call returns `{ answered: false, reason:
  "chat" }`, the plugin's prompt hook behavior.
- **Chat metadata.** `describeToolResult(name, output)` rebuilds the
  `metadata.openchamber` record the plugin attaches (`ok`, the action's title,
  a page's `answer`) from the result text a CLI reports, so the chat draws and
  answers pages on any engine. It answers nothing for other tools.
- **Auth gate.** `registerRoutes` mounts the endpoint beside the plugin
  callback, before the UI auth gate, with the same same-machine rule
  (`callback-address.js`): the CLI holds no UI session and the token is the
  credential. A request carrying `Origin` (a browser) is refused with 403 on
  top of that.

## Agent context budget

- The tool exposes one shared parameter object rather than repeating parameters
  in a large per-action union. Action descriptions carry only required inputs,
  defaults, or one non-obvious semantic detail.
- The action schema carries `oneOf` and no `enum`. A node combining `enum` and
  `oneOf` is valid JSON Schema, but some OpenAI-compatible gateways reject it
  and answer with an empty completion instead of an error.
- Obvious fields rely on their names and JSON types. Parameter descriptions are
  reserved for formats, dependencies, scope, and behavior that cannot be safely
  inferred from the field name.
- Session dispatches never wait. An agent that needs the outcome sets
  `returnResult`: the call still returns at once, with
  `resultDelivery.status: 'pending'` and a note telling the agent not to poll
  or sleep, and the session's final answer is delivered into the calling
  session when it finishes (`../dispatch-results/`). The schema carries no
  `wait` or `timeout`, and the adapter answers a stale `wait`, `timeout`, or
  `lastAssistant` on a dispatch with a usage error naming `returnResult`
  (`agentOnlyUsageError`). `session.messages` does not wait either: it reads
  what is there. The control service keeps `wait` for the CLI only.
- Boolean inputs are checked at the tool boundary: the plugin forwards raw
  JSON, so a field declared `type: 'boolean'` in any tool's schema that
  arrives as anything else (the string `"true"`) fails the call with a usage
  error naming the field (`nonBooleanParameterError`), before any action runs.
  Downstream `=== true` checks would otherwise read it as false.
- The description draws the line against OpenCode's own `subagent` tool:
  `subagent` when the agent delegates part of its own task and wants the
  answer for itself, `session.*` when the user asks for a separate session
  they will follow and talk to.
- The tool exposes only agent-relevant actions
  (`OPENCHAMBER_AGENT_TOOL_ACTIONS`): `schedule.status` stays CLI-only because
  `schedule.list` already returns scheduler status, and enable/disable are one
  `schedule.toggle` action driven by the `disabled` boolean.
- The tool description frames intent: created sessions and scheduled tasks are
  user-facing work the user follows up with. The agent must not decide on its
  own to delegate parts of its current task, but an explicit user request to
  create, send, or schedule always wins, even when it relates to the current
  task (strict models otherwise read the old unconditional "never delegate" as
  a hard ban and refused user-requested sends).
- Optional behavior switches (`worktree`, `pullRequest`, `goal`, `agent`,
  `variant`, `returnResult`) state their default and an explicit "only when
  the user asks" rule so agents do not invent worktrees, goal mode, or result
  deliveries the user never requested.
- `pullRequest` is a pull or merge request number in the project. The session
  starts in a worktree made from it the way the New worktree dialog makes one
  (`../git/DOCUMENTATION.md`, *Worktree creation from a GitHub pull request*);
  everything else about the request is resolved on the server.
- `session.moveToWorktree` moves the calling session (or `sessionId`) into a
  new worktree of its repository, carrying the checkout's uncommitted changes
  along (`../openchamber-sessions/worktree-move.js`). `worktree` is required
  there and `startRef` defaults to the repository's default branch;
  `existingBranch` checks out a branch that already exists instead, local or
  remote (`origin/feature`), and cannot be combined with `branch` or
  `startRef`. When to
  offer it is stated at the head of the tool description, in the form the
  `agentWorktreeMoveWithoutAsking` setting selects: asking first by default,
  or moving unasked and saying so. The setting is read into the plugin source
  (`materializePlugin({ worktreeMoveWithoutAsking })`), so a toggle rewrites
  the managed config like the other tool settings and the running OpenCode
  reads the new description. The session context carries the same rule
  (`../session-knowledge/`, `WORKTREE_MOVE_GUIDANCE`); change both together.
- A rule about when to act belongs where the model reads it before choosing a
  tool: the head of the tool description and, when it must hold in every
  session, the session context (`../session-knowledge/`). An action's
  description is read only after the tool was chosen, so a trigger placed
  there is missed by an agent that never thought the tool applied. Seen with
  `session.link`: told only in the action, an agent investigating an issue
  never linked it; with the rule at the head of the description and in the
  session context, the next agent linked the issue first thing (2026-10-02).
  Action descriptions say what the action does and takes.
- Detailed combination rules are enforced by the shared control service and
  returned as actionable usage errors only after an invalid call. Per-action
  examples and a repeated per-action parameter schema are intentionally omitted.

## Security invariants

- The callback accepts same-machine requests only and requires the current
  per-child bearer token using a timing-safe comparison. Same-machine means a
  loopback source, or, for a listener bound to one concrete address, a source
  equal to that address: the OS sources a local connection to `<ip>` from
  `<ip>`. A wildcard bind keeps the loopback-only rule, and another machine on
  the network always arrives with its own address.
  `callback-address.js` owns this rule; the repository credential helper
  (`lib/git/repository-credential-runtime.js`) reaches the server the same way
  and shares it.
- The token is never persisted, logged, returned to the UI, or written into
  the materialized plugin.
- The plugin adds the callback host to `NO_PROXY`/`no_proxy` inside the managed
  child when it loads. Without that, an `HTTP_PROXY` in the child's environment
  would receive a non-loopback callback, token included, because `fetch` has no
  per-request way to skip the environment proxy.
- Inputs map to a fixed action and parameter allowlist. There is no arbitrary
  CLI, shell, route, or URL forwarding.
- Session/worktree deletion and project-path registration are not exposed.
- A cancelled turn aborts the session's in-flight actions. OpenCode 2 gives a
  plugin tool no abort signal and the plugin's request stays open, so the
  server tracks in-flight actions per session and `abortSession(sessionID)` is
  called from the event dispatch in `server/index.js` when the stream reports
  `session.idle` with `aborted: true`; the abort signal then reaches the
  shared service as before. A dropped HTTP request still aborts as well.

## Result contract

Every completed call returns JSON:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "session.create",
  "data": {}
}
```

Command and operational failures use the same envelope with `ok: false` and
an `error` object. OpenCode-level cancellation can still produce a native tool
error state.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- Web and Desktop engine sessions (Claude Code): every engine process gets its
  own grant to the MCP endpoint; the desktop shell runs the same server
  in-process.
- External OpenCode selected with `OPENCODE_HOST` or skip-start: not injected,
  because OpenChamber does not control that process environment.
- VS Code: not injected; the extension owns a separate OpenCode lifecycle and
  registers no engine routes.
- Hosted and Capacitor mobile clients use the tools of the server they
  connect to; no tool runs in the client runtime.

## The calling tool is part of the request

Each generated tool sends its own name with every callback. Models routinely
drop the namespace their tool's name appears to supply — `openchamber_memory`
asked for `memory.read` gets called as `read` — and resolving the bare name
inside the calling tool's action set makes that unambiguous even where it is not
globally (`delete` belongs to both schedule and memory).

Resolution never reaches outside the tool that asked: `open` from the memory
tool fails rather than driving the browser. An unresolvable action answers with
the actions that tool actually has, because an error that only says
"unsupported" leaves the model to guess a second wrong name — which is exactly
what happened before this existed.

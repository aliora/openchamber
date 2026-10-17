# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.
  - Generation runs through OpenCode's `POST /api/experimental/generate`, which answers with the finished text. There is no throwaway session to create, poll and delete any more.
  - Generation model choice lives in `bridge-git-generation-model.ts`: request model first, then the user's small-model override (`smallModelUseDefault === false` plus `smallModelOverride` as `provider/model`) when the catalog has it, then the model OpenCode's `title` agent is configured with (`agents.title.model`, read through `GET /api/agent/title`, the same step the server-side small-model resolver honors, skipped when the catalog lists that model as disabled), then the zen fallback, each of the catalog-checked steps honored only when the catalog holds the model. The old `gitProviderId`/`gitModelId` pair is no longer read.
  - Catalog reads, the title-agent read, and generation all name the flow's directory through the `x-opencode-directory` header, and the model catalog cache is keyed by that directory. OpenCode resolves models per location, so an unscoped read would answer for OpenCode's own working directory and reject models that work in the repository.
  - Specialized Git flows (`commit-message`, `pr-description`, `conflict-details`) and generation helpers.
  - Commit message prompt templates stay aligned with `git.commit.generate.*` in `packages/ui/src/lib/magicPrompts.ts`, including on-disk magic-prompt overrides.

- `bridge-small-model-runtime.ts`
  - Answers `GET /api/small-model`, which the web server serves elsewhere and OpenCode does not know. The webview routes the path to `api:small-model:get` before the generic proxy.
  - Returns `authenticatedProviders` only, computed like the server's `listAuthenticatedProviders`: every provider with an enabled model, OpenCode's provider order first. The Small Model and walkthrough pickers list models from it. `available` and `model` are not computed here, so the small-model availability store stays "unknown" in VS Code.
  - Both reads name the request's directory through `x-opencode-directory`. A failed read answers an error; the picker then keeps its previous list.

- `git-commit-message.ts`
  - Pure parse/format/file-selection helpers for commit generation (no `vscode` import).
  - A path with a meaningful index status uses only the staged (`--cached`) diff. Extra working-tree hunks stay out of the prompt.

- `scmCommitMessage.ts`
  - Source Control title-bar command. Resolves the git repo, prefers staged files then unstaged/untracked, writes the result into `Repository.inputBox` only if that box still matches the value captured when generation started. Light theme reuses `icon.svg`. Dark theme uses `icon-scm-titlebar.svg` (`#C5C5C5`) because that slot does not theme `currentColor` and `icon-titlebar.svg` is mint. A blank icon over SSH/DevPod is [vscode-remote-release#11686](https://github.com/microsoft/vscode-remote-release/issues/11686), not a missing asset.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution. Both bridge helpers and `gitService.ts` use this executor; the latter passes the Git binary selected by VS Code's Git extension.
  - Reads both output streams and gives commands EOF on stdin. A signal exit is a failure, never exit code zero. File ignore checks pass their deadline to this executor so timeout terminates the child tree rather than abandoning a live command behind `Promise.race`. Other Git commands have no new time limit.
  - Tracks outstanding commands through completion and timeout cleanup. Extension deactivation awaits `stopGitProcesses`, which terminates active work and rejects later launches. Operations delegated to VS Code's built-in Git API remain owned by that extension.

- `owned-process.ts`
  - Owns background child termination shared by Git and the bundled OpenChamber server (`spawnOwnedIpcProcess` adds the server's IPC channel). POSIX children have a separate process group, which receives SIGKILL after the grace period or root exit so a SIGTERM-resistant descendant cannot survive. Windows enumerates and terminates the tree before losing its root, using an asynchronous hidden `taskkill` invocation. Completion waits for stdio closure; failed termination remains an error.

- `opencode.ts`, `openchamber-server-lifecycle.ts`, `openchamber-server-process.ts`, `openchamber-server-entry.ts`, `openchamber-server-protocol.ts`
  - Start, stop, restart and crash recovery of the OpenChamber server the extension bundles, which answers the webview's OpenCode 2.x calls. See *The bundled OpenChamber server* below.

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - `api:git/diff` and `api:git/file-diff` classify the status path first through `gitPathDiff.ts`, matching the web server's diff routes. The host answers `{ kind: 'diff' | 'file-diff', ..., submodule }` or `{ kind: 'unavailable', reason: 'path_not_found' | 'nested_repository', message }`, and `webview/api/git.ts` parses that into the shared contract, throwing `GitPathUnavailableError` for unavailable paths. A failing `git diff` rejects instead of returning an empty patch. These handlers are currently dead bridge surface (see below), so the contract is covered by `gitPathDiff.test.ts` and `webview/api/git.test.ts` rather than by a reachable screen.
  - Fetches the current tracked source branch once before worktree creation. Fetch failure falls back to the local branch and reports it to the shared UI.
  - A new worktree first runs the project's start command, read through the web server's `lib/opencode/project-start-command.js` from the server the manager's API URL names (wired in `extension.ts`), then the start command the request names.
  - Fast worktree creation reports bootstrap phases explicitly: `directory-created`, then `git-ready` after Git population/upstream work, and `setup-ready` after setup commands. Existing worktrees without tracked bootstrap state fall back to `ready`/`setup-ready`; shared webview consumers also accept legacy responses without `phase`.
  - Worktree removal waits for an active create/bootstrap task for the same directory so background Git and setup work cannot race deletion or restore stale bootstrap state. It then releases the removed worktree's OpenCode instance through the bridge-injected `disposeInstance` hook, after git confirms the linked worktree and before `git worktree remove`, while the path still resolves. Disposal is best-effort: failures (including an unavailable managed runtime or a timed-out request) are logged as a warning and never fail the removal. The primary workspace and the orphan fallback are never disposed.
  - Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long".

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - active-directory selection across multi-root workspaces
    - dropped-file parsing and attachment reading
    - models metadata fetch helper
  - Read paths are authorized in the requested workspace path space before symlink resolution, matching the web runtime; directly requested outside-workspace paths remain denied.

The sidebar installs a script-free CSP bootstrap document before changing webview options, so VS Code does not diagnose the transient blank document as an extension webview without CSP. The final webview CSP permits `blob:` only for `worker-src` so shared UI parsers can run bounded local decompression off the main thread. Blob scripts remain disallowed by `script-src`.

The webview build emits each worker as one self-contained file. VS Code webviews cannot load workers directly from extension resource URLs or load module imports from inside a worker. The shared Shiki client therefore fetches the built worker, starts it from a `blob:` URL, and relies on the worker CSP allowance above.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.
  - `/api/fs/directory-stat` and `/api/fs/directory-stats` return 501 locally. Directory-availability probes remain unknown in VS Code rather than falling through to OpenCode.
  - Workspace-contained Markdown gallery images use these local filesystem
    routes without calling the server grant route. Grant requests for OpenCode
    temporary-directory images return an explicit unsupported response instead
    of being forwarded to OpenCode.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - The webview forwards the request path unchanged (`/api/<x>` → `/api/<x>`) to the bundled server, whose engine routes serve the OpenCode 2.x API under `/api`, so nothing strips the prefix.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.
  - OpenCode 2.x has one global stream, `GET /api/event`. Every frame names its own `location.directory`, so the proxy no longer scopes the request to a directory.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - `/api/config/opencode-resolution` is not answered here; it reaches the bundled server through the proxy.
  - OpenCode JSONC reads in `opencodeConfig.ts` fail closed on a partial or non-object `jsonc-parser` tree (`INVALID_JSONC`) so mutations cannot rewrite a `$schema`-only stub over an existing config. Comment-only files read as empty, while other content that yields no JSON value (YAML, plain text) fails closed. A broken layer is omitted from the merge and recorded on `layerErrors`; valid sibling layers still load, including plugin list/read via `getPluginConfigSources`. Writes still refuse to overwrite the broken file.
  - `writeConfig` and the agent/command markdown writer replace their file atomically through `writeFileAtomic` from `packages/web/server/lib/opencode/atomic-write.js`, the same function the web server uses, so OpenCode's watcher never reads a partial file.
  - Config writes through `writeConfig` are structural, not whole-file re-serializations: the parsed file is diffed against the desired config and each change is applied with `jsonc-parser` edits (property removal locates the separator comma with the scanner so surrounding comments survive and no stray comma is left behind). Comments, formatting, and line endings outside the changed values are preserved; changed arrays are replaced whole; comment-only files keep their comments with the serialized config appended below. The edited text must re-parse to exactly the intended config or the write falls back to a normalized rewrite, so a structural edit can never corrupt the file.

- `bridge-project-setup-runtime.ts`
  - Extension-host side of `GET/PUT /api/projects/:projectId/config` (the webview handles the route locally and bridges `api:project-setup:get` / `api:project-setup:update`). Reads and writes the client-owned keys of `~/.config/openchamber/projects/<projectId>.json` (worktree setup commands, project actions, draft starters) with the rules in `project-setup.ts`, a mirror of the server's `packages/web/server/lib/projects/project-setup.js`; keep the two in sync. The file name follows the server's bounded rule (`projectConfigFileStemOf`, mirrored from `packages/web/server/lib/projects/project-id.js`): an id over 200 characters is stored as `path_sha256_<digest>.json` so a deeply nested checkout does not exceed the file name limit. A file an older build wrote under the long name is still read when the bounded one is missing and is removed once a write has moved its content. Writes to one file are chained; server-owned and unknown keys survive. The read also merges the team's optional `<workspace>/.openchamber/project.json` (checkout path decoded from the `path_<base64url>` id) by the same rules as the server, so the webview sees one view with `shared` / `personal` blocks. The shared UI (`openchamberConfig.ts`) no longer composes that path or reads it through the fs bridge.
- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.
  - Writes are gated by the generated registry snapshot (`settings-registry.json`, via `settings-registry-gate.ts`): keys the registry does not list, or marks `computed`, `local`, or `owner: desktop-shell`, never reach the shared settings files. Regenerate the snapshot with `bun run settings-registry:generate` when the UI registry changes.
  - Shared settings live in two files under `~/.config/openchamber/`, split by `settings-files.ts` (a pure mirror of the server's `settings-files.js`; both write the same bytes): `settings.json` holds instance facts and legacy keys, `preferences.json` (`{ version: 1, fields: { key: { value, updatedAt } } }`) holds every registry `profile` key. `updatedAt` is stamped by the extension host only when a value actually changes. Reads return the merged view (preferences win). A missing `preferences.json` is seeded once from the profile keys still in `settings.json`; every write keeps a copy of the profile's base values in `settings.json` too, so a build from before the split (which reads only that file) still finds the user's preferences; it is ignored by current builds.
  - An existing but unparseable `preferences.json` is a failure, not an empty profile: it is never seeded over or rewritten, one warning is logged per process, reads return `settings.json` only, and writes drop the profile part until a later read succeeds.
  - Both files are written atomically (tmp file + rename). Write failures throw, so `persistSettings` rejects and the webview sees the save fail instead of a silent success.
  - The extension host is always the `vscode` surface kind: per-surface profile keys it changes land under `surfaces.vscode` in `preferences.json` and reads resolve `vscode` first, base otherwise (mirrors the server's header-driven behaviour).

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - `api:notifications:show` hands the webview's notification to `openchamber.internal.showNotification` in `extension.ts`, which shows it through `sessionNotifications.ts` and answers `{ shown }`. Chromium never displays a `new Notification()` from a webview frame, so the extension host is the only place a VS Code notification can come from.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`, and `/api/sessions/status`, where busy phases become the host status seed the shared UI reads for unopened directories).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Enterprise mode: the extension host reads the machine policy through the bundled `packages/web/server/lib/enterprise-mode.js` (policy file, or `OPENCHAMBER_ENTERPRISE_MODE` in the editor's environment) for the bridges it answers itself. `api:openchamber:enterprise-policy` answers the webview's `/api/openchamber/enterprise-policy`; with the mode on, `api:provider:upsert` is refused, the update check never reports usage, and `bridge-proxy-runtime.ts` answers the provider-connect routes (`isProviderConnectRequest`) with 403 `enterprise_mode` instead of forwarding them; MCP server sign-in passes, as on the web server. The bundled server enforces the mode on what it serves, as it does on the web: engine sign-in answers 403 `enterprise_mode`, and it listens on loopback only. It runs with relay hosting off, and the webview answers the tunnel routes as unsupported.
  - Stored credentials: `bridge-proxy-runtime.ts` answers `GET /api/credential` (`isCredentialListRequest`, any spelling OpenCode routes the same way) with 403 `credential_list_refused` in and out of enterprise mode. It returns every key with its secret; the extension host reads it for itself through `opencodeAuth.ts`, and the webview never gets it. Both this check and the provider-connect one run on the path as OpenCode receives it: the webview path is resolved as a URL first (so `/http:api/credential` counts as `/api/credential`), and a path that would resolve to another origin gets 400.
  - Git initialization: `POST /api/vcs/init` in the home directory, at a disk root, or without a directory gets the same 400 `InvalidRequestError` the web server answers (`vcsInitRefusal` from `web/server/lib/git/repository-root.js`), checked on the resolved path before anything reaches OpenCode.
  - `/api/opencode/version`, `/api/opencode/upgrade-status` and `/api/opencode/upgrade` are not answered here; they reach the bundled server through the proxy and answer as on the web.
  - Provider handlers cover source lookup, disconnect (`DELETE /api/provider/:id/auth`), and custom provider upsert (`PUT /api/provider`; create/update OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages config with explicit `scope` for user/project/custom layers; requires `env` or stored auth; secrets via OpenCode auth API). Updates preserve existing provider, option, and retained-model fields that the form does not manage while honoring explicit model, header, and env removal. Legacy `providers` entries migrate to the canonical `provider` key when edited.
  - `api:provider:discover-models` runs the shared server discovery module in the extension host, so the webview never sends provider credentials or custom headers through the generic OpenCode proxy. In edit mode the host reads the provider's OpenCode-stored key when the form leaves it blank; a replacement key typed into the form wins. Enterprise mode refuses discovery before any network request.
  - Quota handlers (`api:quota:providers`, `api:quota:get`) answer for Claude and Codex only. `quotaProviders.ts` reads the login each CLI keeps on the machine, read-only: Claude Code's Keychain entry (macOS), `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN`, and Codex's `${CODEX_HOME:-~/.codex}/auth.json`. It never refreshes a token and never logs credential text. A CLI without a login is `configured: false` and its fetch never runs. The module duplicates `packages/web/server/lib/quota/`, which documents the semantics; keep the two in sync.

- Plugin metadata checks use `packages/web/server/lib/opencode/npm-registry-config.js`, the same resolver as the web server. It reads inherited registry settings and the user's `.npmrc`, supports scoped registries, and sends credentials only in HTTP headers.

- `sessionNotifications.ts`
  - Shows OpenChamber notifications (finished turn, error, question, the Settings test) as `vscode.window.showInformationMessage`. The webview keeps deciding which events notify and their text from the shared notification settings.
  - With "Notify while app is focused" off (`requireHidden`), a notification is skipped only while VS Code is focused and an OpenChamber chat, the sidebar or a session tab, is on screen. A hidden or collapsed chat counts as out of view. Any visible chat is enough, whichever session it shows; `packages/ui/src/lib/surfaceAttention.ts` decides unread per chat instead, so a session finishing behind another visible chat is marked unread without a notification.
  - A session notification carries "Open Session", which reveals the sidebar and selects that session (`openSession` webview command). Every open webview asks for the same session event, so repeats of one session message within 10 seconds show once; a notification without a session, the Settings test, is never deduplicated.
  - Kept free of the `vscode` import so it is unit tested directly.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Serializes reads and read-modify-write updates, persists a monotonic policy revision, and broadcasts the exact committed snapshot to every active OpenChamber webview. Permission replies remain foreground UI-owned: the webview answers `/api/permission-auto-accept` from this store, never from the bundled server. The bundled server runs engines, so the webview never acts on this policy there: the composer shows the engine's Permission menu and the foreground responder stays idle (`isOpenChamberAutoAcceptActive` in `packages/ui/src/stores/useEngineControlsStore.ts`). The policy stays stored for a server without engines.

## Git in the webview

VS Code manages Git hosting providers and Git credentials itself, so the extension host exposes only the standard Git operations in `gitService.ts` and `bridge-git-runtime.ts`. Push, pull, fetch and remote-branch deletion run as plain Git commands with whatever credentials the user's Git setup provides. The extension host stores no source-control bindings, provider accounts, transport credentials or author profiles.

The shared UI reads a repository context and binding before every Git network operation and drives push, pull, fetch, sync and remote-branch deletion through the `planNetworkOperation` / `executeNetworkOperation` lifecycle. `webview/api/git-remotes.ts` and `webview/api/source-control.ts` satisfy that contract without a store: they project the repository's remotes, read through `api:git/remotes` and redacted of userinfo, as a `bound` binding whose every remote is a ready System-transport grant. `webview/api/git.ts` keeps planned operations in webview memory and maps `executeNetworkOperation` onto `api:git/push`, `api:git/pull`, `api:git/fetch` and `api:git/remote-branches`; a bridge failure becomes a `failed` snapshot with `TRANSPORT_FAILED` and the Git error text, and sync records per-step results. Plans never reach the extension host, cancellation only affects a plan that has not started, and operation snapshots do not survive a webview reload.

Provider authentication, capabilities, issues, change requests, contributor destinations (`{ kind: 'ordinary' }`), clone, checkout hydration, worktrees created from a change request or with `ensureRemoteUrl`, and transport or auxiliary binding configuration are unsupported in the webview adapters and never reach the OpenCode proxy. The shared Git view therefore hides the repository binding strip in VS Code, and the Git settings page hides provider and managed SSH sections. Author profiles live in webview memory for the lifetime of the view and are not persisted; applying one sends the profile's author fields through the standard `api:git/identity` message.
- `InlineCommentThreads.ts`
  - Owns the `openchamber.inlineComments` comment controller: the gutter `+` range, the thread opened by `openchamber.addLineComment`, and every thread a submitted comment leaves anchored in the editor until the message goes out.
  - A thread never owns a draft. It mints the draft id, hands the payload to a chat webview with the same routing as Add to Context (the active session panel when one exists, else the sidebar, revealed if needed), and follows the webview's whole-draft-list `inlineComments:sync` snapshots: present means show, absent after having been seen means dispose. A snapshot is tagged with the surface that produced it (a panel id or `sidebar`) and only decides that surface's own threads, because every webview runs its own draft store.
  - A comment the composer never confirms holding within 30 s is retracted from every surface's pending hold, its thread disposed, and the user told, so a thread cannot promise a send that will never happen.
  - `inlineCommentSelection.ts` holds the pure pieces (line ranges, the diff-side and real-path resolution for `git:` documents, the pending hold, removal broadcast, thread fate) without the `vscode` import so they are unit-tested directly.
  - Webview side: `webview/inlineCommentTarget.ts` decides where a delivered comment is filed. A session panel stamps its session on every comment it delivers and the webview waits until it shows that session; the sidebar files on its current session or open draft. Filing on the first snapshot with a directory put the draft under `draft` while a fresh panel was still loading its session list, a key that composer never reads. `webview/inlineCommentRemovals.ts` remembers removals that arrive before a delayed delivery lands, so a comment dropped while its panel was still booting does not appear as a chip later. The extension is not activated on startup for this; the right-click command activates it, and the gutter `+` appears from then on.

## Shared webview message ordering

The bridge sends `webview:ready` once per document, before its first outbound
message. Sidebar and session-editor hosts abort that panel's old
SSE streams before accepting new requests and resend the current connection
state. A VS Code webview reload or cross-window move replaces the document
without disposing its panel; relying only on panel disposal leaked one upstream
stream per reload, including its ongoing idle heartbeat traffic.

Each host also sends `viewerStateChanged` with `{ windowFocused, surfaceVisible }`: on resolve and on `webview:ready`, when the VS Code window gains or loses focus, and when that view or panel is shown or hidden. The webview parses it at the bridge and hands it to `packages/ui/src/lib/surfaceAttention.ts`, which decides whether a finished turn in the selected session counts as seen. The webview document's own `hasFocus()` is not used for this, because focus in the code editor would otherwise mark a visible chat as unread.

Message and part ordering is owned by [`packages/ui/src/sync/DOCUMENTATION.md`](../../ui/src/sync/DOCUMENTATION.md#session-message-loading). The VS Code webview consumes that shared sync implementation; bridge and proxy runtimes pass OpenCode records through without adding runtime-specific ordering.

The webview does not open the OpenChamber control stream
(`/api/openchamber/events`): `subscribeOpenchamberEvents` returns a no-op
subscription in VS Code before resolving URLs or opening a connection. The
bundled server serves that stream, but nothing routes it through the SSE bridge
yet. Session sync uses the `/api/event` SSE bridge and global session polling.
Sending the control stream to the webview origin caused repeated `403`
responses and URL-token requests to `/auth/url-token`.

Shared lazy imports retry a failed chunk load, but skip browser-navigation
recovery in VS Code. `window.location.reload()` is unsupported inside webviews;
the original import error must reach the UI error boundary instead.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## VS Code surface reachability map

Verified 2026-08-28 against `8f5eb231b`.

Two webview hosts, both rendering `renderVSCodeApp` → `VSCodeApp`
(`packages/ui/src/apps/VSCodeApp.tsx`):

- `ChatViewProvider.ts` — sidebar view, `viewMode: 'sidebar'`.
- `SessionEditorPanelProvider.ts` — editor tab, `viewMode: 'editor'`. A tab opened by `openchamber.openAgentManager` (titled "Run on Several Models"; the id predates multi-run and stays for existing keybindings) carries `initialComposer: 'parallel'`, so its new-session draft starts in parallel mode.

The old Agent Manager panel (its own provider, `AgentManagerView` and group store) is gone. It listed worktree sessions it never bootstrapped into sync, so its chats missed live events; runs now use the shared sidebar rows, run overview and composer.

`VSCodeLayout` has exactly three views: `sessions`, `chat`, `settings`
(`packages/ui/src/components/layout/VSCodeLayout.tsx:76`). There is no
`MainLayout`, no `ContextPanel`, and no `ContextPanelRail` in this runtime, so
every surface reached only through those is unreachable.

### Surfaces

| Surface | Status | Mount chain / cut-off |
|---|---|---|
| Chat timeline | MOUNTED | `VSCodeLayout` → `ChatView` → `ChatContainer` → `MessageList` |
| Composer | MOUNTED | `ChatContainer` → `ChatInput` (model/agent controls, autocomplete, attachments, dictation, GitHub issue/PR pickers, `ReviewFlowDialog`, `PendingChangesBar`) |
| Work status panel | MOUNTED | `ChatContainer` → `WorkStatusPanel` |
| Permission / form cards | MOUNTED | `ChatContainer` → `PermissionCard`, `FormCard` |
| Timeline dialog | MOUNTED | `ChatContainer` → `TimelineDialog` |
| Tool output / inline diff preview | MOUNTED | `MessageList` → `ToolPart`, `ToolOutputDialog` (`DiffViewToggle`, not `DiffView`) |
| Sessions sidebar | MOUNTED | `VSCodeLayout` → `SessionSidebar` with `mobileVariant hideDirectoryControls` |
| Session dialogs | MOUNTED | `VSCodeLayout` → `SessionDialogs` |
| Session switcher | MOUNTED | `VSCodeHeader` → `SessionSwitcherDropdown` |
| MCP dropdown | MOUNTED | `VSCodeHeader` `showMcp` → `McpDropdown` |
| Context usage / rate limits | MOUNTED | `VSCodeHeader` `showContextUsage` / `showRateLimits` → `ContextUsageDisplay`, `UsageProgressBar` |
| Multi-run | MOUNTED | `SessionSidebar` run rows; `RunOverview` over the chat in every layout (sidebar, expanded, editor tab); composer parallel mode from the model picker and the `openchamber.openAgentManager` tab |
| Settings | PARTIAL | `VSCodeLayout` → lazy `SettingsView`. `metadata.ts` `isAvailable: (ctx) => !ctx.isVSCode` hides `remote-instances`, `git`, `shortcuts`, `magic-prompts`, `voice`, `tunnel`, `about` |
| Usage / quota page | MOUNTED | `SettingsView` → `UsagePage` (slug `usage`, no VS Code gate) |
| Notifications settings | MOUNTED | `SettingsView` → slug `notifications` (no VS Code gate) |
| MCP settings | MOUNTED | `SettingsView` → `McpSidebar` / `McpPage` |
| Agents / commands / skills / plugins / providers / projects settings | MOUNTED | `SettingsView` page registry |
| Worktrees | PARTIAL | Create/remove reachable via `SessionSidebar` → `NewWorktreeDialog` and `sessionWorktreeMenu`. `WorktreesView` is `MainLayout`-only |
| Git | PARTIAL | Read-only status/branches/log via `useGitStore` in `SessionSidebar`, `ChatInput`, `WorkStatusPrimaryGroup`. Stage/commit/push/history/merge/rebase live in `GitView` + `views/git/*`, cut off with `ContextPanel` |
| Voice / dictation | PARTIAL | `ComposerDictation` renders in `ChatInput`; the `voice` settings page is VS Code-gated |
| Command palette | PARTIAL | `useKeyboardShortcuts` runs from `SyncAppEffects` and `open_command_palette` toggles `isCommandPaletteOpen`, but `CommandPalette` renders only in `MainLayout` — the shortcut opens nothing |
| ContextPanel / project context (notes, todos, plans tabs) | NOT MOUNTED | `ContextPanel`, `ContextPanelRail`, `RightSidebarTabs` imported only by `MainLayout` and `MobileWorkspaceDrawer` |
| Terminal | NOT MOUNTED | `TerminalView` imported only by `ContextPanel` and `MobileWorkspaceDrawer`. `webview/api/index.ts` ships `createStubTerminalAPI()` whose every method throws unsupported |
| Files view | NOT MOUNTED | lazy `FilesView` in `ContextPanel`; `SidebarFilesTree` is `MainLayout`-only |
| Diff view | NOT MOUNTED | lazy `DiffView` in `ContextPanel` |
| Git view | NOT MOUNTED | lazy `GitView` in `ContextPanel` |
| Plan view | NOT MOUNTED | lazy `PlanView` in `ContextPanel`, `ProjectNotesTodoPanel`, `MobileApp` |
| Pull request view | NOT MOUNTED | `PullRequestView` imported only by `ContextPanel` |
| Browser panel | NOT MOUNTED | `BrowserPane` imported only by `ContextPanel`; `RuntimeAPIs` has no browser member in `webview/api/index.ts` |
| Monitoring other hosts | UNSUPPORTED | `webview/api/hosts.ts` answers `unsupported`: the extension saves no other OpenChamber hosts, so `useMonitoredHosts()` lists none |
| Walkthrough | NOT MOUNTED | `WalkthroughView` imported only by `ContextPanel` |
| Archive view | NOT MOUNTED | `ArchiveView` imported only by `MainLayout` |
| Scheduled tasks | NOT MOUNTED | `ScheduledTasksDialog` imported only by `MainLayout` |
| Memory debug panel | NOT MOUNTED | `MemoryDebugPanel` imported only by `App.tsx` (web/desktop root) |
| Mini chat | NOT MOUNTED | `MiniChatLayout` imported only by `ElectronMiniChatApp` |

### Dead bridge surface

Handlers with no reachable caller in the VS Code webview.

| Handler | Why unreachable |
|---|---|
| `api:git/ignore-openchamber` | No reference anywhere in `packages/vscode/webview` |
| `api:git/commit`, `api:git/commit-files`, `api:git/commit-file-diff` | Only `GitView` and `views/git/*` call them |
| `api:git/log` (write paths), `api:git/checkout`, `api:git/checkout-commit`, `api:git/reset-to-commit`, `api:git/revert-commit`, `api:git/cherry-pick` | `views/git/HistoryCommitRow.tsx` only |
| `api:git/merge`, `api:git/merge/abort`, `api:git/merge/continue`, `api:git/rebase`, `api:git/rebase/abort`, `api:git/rebase/continue`, `api:git/conflict-details` | `GitView` only |
| `api:git/push`, `api:git/pull`, `api:git/fetch` | `GitView` and `MobileChangesSurface` only |
| `api:git/diff`, `api:git/file-diff` | `DiffView` only |
| `api:git/commit-message` | Wired from `webview/api/git.ts`. GitView is still unmounted, so no VS Code webview UI calls it. The SCM title-bar command uses the same generator on the extension host. |
| `api:git/pr-description` | `views/git/PullRequestSection.tsx` only |
| `api:git/identity` | `git` settings page is VS Code-gated |
| `api:github/pr:create`, `api:github/pr:merge`, `api:github/pr:ready`, `api:github/pr:update` | `views/git/PullRequestSection.tsx` only. `api:github/pr:status` and `api:github/pr:summaries` stay reachable through `useGitHubPrStatusStore` in the sidebar and answer with the disabled-backend error |
| `api:fs:write`, `api:fs:rename`, `api:fs:delete`, `api:fs:reveal`, `api:fs:mkdir` | `FilesView`, `SidebarFilesTree`, `PlanView` only |
| `api:fs:exec` | Terminal API is a throwing stub; no other caller |

Reachable filesystem routes: `api:fs:read` (attachments), `api:fs:search`
(`useFileSearchStore` behind composer file mentions), `api:fs:list`, `api:fs:stat`.

Maintenance: reviews, changelog entries, and parity claims consult this map;
whoever mounts or unmounts a surface updates it in the same change.

## Network connections

Extension activation applies `networkDefaults.ts` before registering handlers.
It gives Node connection attempts 5 seconds, matching the web runtime, so quota
requests to distant providers can connect. This is an extension-host process
default, including other Node connections in that host. Address-family selection
stays unchanged; runtimes without the setter retain their existing behavior.

## The bundled OpenChamber server

Sessions run on the engine layer (`packages/web/server/lib/engine/`), in the
same server the web runtime and the desktop app run. The extension host starts
that server as a child process, and the proxy forwards the webview's OpenCode
2.x calls to it, so the engine routes answer them exactly as on the web.

- `scripts/build-server.mjs` (`bun run build:server`, part of `build` and
  `dev`) bundles `openchamber-server-entry.ts` and the whole server, npm
  dependencies included, into `dist/openchamber-server/server.mjs`, about 5 MB
  minified. The VSIX ships without `node_modules`. Server modules find files
  next to themselves through `import.meta.url`; the build rewrites each server
  module's `import.meta.url` to its original path under
  `dist/openchamber-server/` and copies every sibling file such a module names
  (the settings registry, the gatekeeper program, the Git credential helpers).
  It writes an empty built-in extension registry, because the extension shows
  no extension panels. `node-pty`, `bun-pty` and `sherpa-onnx-node` stay
  external: the server loads them lazily for the terminal and local dictation,
  which VS Code does not offer.
- `openchamber-server-entry.ts` starts the server API-only on `127.0.0.1` with
  port 0 and reports `{ type: 'ready', port }` or `{ type: 'failed', message }`
  over IPC (`openchamber-server-protocol.ts`). A `{ type: 'stop' }` message,
  or the channel closing because the extension host died, shuts it down
  gracefully. It removes `ELECTRON_RUN_AS_NODE` from its environment before
  any engine CLI inherits it.
- `openchamber-server-process.ts` spawns the entry with `process.execPath` and
  `ELECTRON_RUN_AS_NODE=1`, so VS Code's own binary runs it as Node, in its own
  process group with an IPC channel (`owned-process.ts`). Startup waits up to
  30 seconds for the port. A timeout, cancellation, a reported failure or an
  early exit kills the process tree and rejects with the end of the server's
  output. Stopping sends `stop`, waits up to 5 seconds, then kills the process
  group, which on POSIX also ends the engine CLIs the server started. The
  stop request goes over IPC because in Node a child whose parent closed the
  channel exits without its `close` event ever firing.
- `openchamber-server-lifecycle.ts` owns start, stop, restart and crash
  recovery, without the `vscode` import, so it is unit tested. A server that
  exits on its own is restarted after 1, 5 and 15 seconds; a run of a minute
  resets the count. After the third failed attempt the status stays `error`
  until the user restarts the connection. Requests wait for `connected`
  meanwhile (`opencode-ready.ts`). Stop cancels a startup in progress, a
  pending restart, and starts and restarts queued before it.
- `opencode.ts` wires that to VS Code: the script path, the global storage
  folder as working directory, the environment (`OPENCHAMBER_RUNTIME=vscode`,
  `OPENCHAMBER_RELAY_HOST=off`, `OPENCHAMBER_SKIP_API_COMPRESSION=true`,
  recorded through `assignInjectedEnv`), status text, and `openchamber.apiUrl`.
  With that setting the extension starts nothing and forwards to the named
  server without credentials.

The desktop app starts the server inside its own main process. The extension
runs it in a child process because the server installs `uncaughtException` and
`unhandledRejection` handlers, signal handlers and a process-wide outbound
proxy, which would apply to every extension in the shared extension host, and
its startup wires module-level state once, so it cannot be restarted in place.
A child process restarts cleanly after a crash. It costs one Node process per
extension host, as OpenCode did.

The server runs on the extension host's Node. The bundle starts on Node 20
and 22; Node 18, which VS Code 1.85 to 1.89 ship and `engines.vscode` still
allows, is untested.

The server listens on loopback without a UI password, as the desktop app's
does by default, so any local process can call it. A password would break the
server's calls to its own routes (the `/api/opencode/*` routes call
`/api/info`), which carry no credentials and answer 401 once one is set.

It shares the data directory with every other OpenChamber server on the
machine, so a session started in VS Code also shows in the desktop app.
Scheduled tasks run in whichever server claims them first. Relay hosting is
off, so paired devices keep reaching the desktop app or `openchamber serve`.
In code-server every browser connection gets its own extension host, and each
host runs its own server until code-server ends that host.

`/api/opencode/version`, `/api/opencode/upgrade-status`, `/api/opencode/upgrade`
and `/api/config/opencode-resolution` reach the server through the proxy and
answer as on the web. The webview still answers `/api/opencode/health` from
the connection status. `GET /api/engines/readiness` reaches the server like
every engine route, so the model picker greys out an engine whose CLI cannot
run, as on the web.

The config, skills and Git generation bridges still work against OpenCode's
config files and routes. The engine serves neither
`POST /api/experimental/generate` nor `GET /api/agent/title`, so commit message
and PR description generation fail in VS Code.

## Global OpenCode paths

`opencodeConfigPaths.ts` owns the global config directory for config CRUD,
skill discovery/install, and global AGENTS.md. It
resolves `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode` at extension startup (the same rule OpenCode 2 applies);
only `opencode.json(c)` is a config file, the v1 `config.json` is not read. Project paths, the explicit
`OPENCODE_CONFIG` file layer, and the auth data directory stay separate.
When both global files exist, every config entry lookup reads
`opencode.jsonc` after `opencode.json`, so on a name clash the `.jsonc` entry
wins. This covers MCP servers, agents, and commands: editing or deleting an
entry updates the file that defines it, and without `OPENCODE_CONFIG` a new
user-scoped entry goes into the primary config file.
An invalid secondary file cannot answer an empty MCP list or a missing-server
lookup as success; those reads report the parse error instead. An agent or
command lookup that reaches the global files reports the same error.
No files are migrated. The behavior GET bridge response includes the effective
`path` for both existing and missing AGENTS.md files; shared Settings uses it
in the warning.

## OpenCode 2 config shapes

`opencodeConfig.ts` is the extension-host mirror of the web server's
`packages/web/server/lib/opencode/*` entity modules. Both must write identical
files, so all the shape logic lives in one place: `opencode-config-v2.ts` is a
thin re-export of `packages/web/server/lib/opencode/config-v2.js`, bundled in by
esbuild the same way `provider-env-aliases.ts` is. Do not reimplement a
conversion here — add it to the web module and it lands in both runtimes.

Ownership and the v1 fallback policy are documented once, in
`packages/web/server/lib/opencode/DOCUMENTATION.md` under "Entity routes
(v2 shapes)". The short version:

- Reads accept the v2 keys (`agents`, `commands`, `providers`, `mcp.servers`,
  `plugins`, `permissions`) and fall back to the v1 keys OpenCode 2 still
  decodes (`agent`, `command`, `provider`, `mcp.<name>`, `plugin`,
  `permission`/`tools`). v2 wins when both exist.
- Writes emit v2 only, into the v2 directory (`.opencode/agents/`,
  `.opencode/commands/`, `.opencode/skills/<id>/`, `.opencode/plugins/`).
- Files are never moved. Updating an entity that lives in a v1 file rewrites it
  at its own path in v2 shape, and a v1 JSON entry moves to the v2 section key
  inside the same file. Every mutation returns the `path` it wrote.

Bridge surface (`bridge-config-runtime.ts`), matching the web routes:

- `api:config/agents` — `GET` answers the `sources` envelope; `GET` with
  `resource: "config"` answers `{ source, scope, path, legacy, config }` and
  with `resource: "permissions"` answers `{ global, agent, effective, source,
  path }`. `POST`/`PATCH` take an `AgentEntity` body (a v1 `permission` map and
  the v1 `prompt` alias are still accepted) and report the written `path`.
- `api:config/disabled-agents` — `GET` answers `{ agents }`, the agents whose own
  config says `disabled: true`. OpenCode drops them from its agent list, so
  Settings reads them here to offer Enable. Mirrors `/api/config/disabled-agents`.
- `api:config/commands` — same, with `resource: "config"` and a `CommandEntity`;
  `subtask` is accepted as the v1 name for `subagent`.
- `api:config/mcp` — `McpEntity` bodies; entries carry `sectionKey` and
  `legacy`.
- `api:config/websearch` — `PUT /api/config/websearch`; `{ selection }` is
  `false`, `null` (remove the key), `"random"` or a provider id, written with
  the shared `writeWebSearchSelection` to `OPENCODE_CONFIG` or the user config.
  `{ method: "GET", directory }` returns `{ projectPath }` from the shared
  `findWebSearchProjectOverride`: the project config that overrides that write.
- `api:config/warming` — `PUT /api/config/warming`; `{ enabled }` turns session
  warming on (`true`, keeping a hand-tuned object) or off (removes the key),
  written with the shared `writeWarmingEnabled` to the same file.

## Session archive and metadata

OpenCode 2.x has no route that archives a session, so archive flags are
OpenChamber-owned state. `openchamberSessionState.ts` keeps the same
`sessions-archive.json` the OpenChamber server keeps, in the shared OpenChamber
config directory (`~/.config/openchamber`, `%APPDATA%\openchamber` on
Windows), which is also the web server's default data directory: a session
archived from VS Code is archived in the desktop app on the same machine, and
the other way round. Nothing is cached between calls because two processes can
write the file; every write re-reads first and replaces the file atomically.

Session metadata lives on the OpenCode record (`PATCH /api/session/{id}`,
OpenCode 2.0.15+). OpenCode replaces the whole object, so a write reads the
record, applies the JSON Merge Patch (RFC 7386) and writes the result, and
features sharing the `openchamber` namespace do not erase each other. An entry
an older version left in `sessions-metadata.json` is laid over the record on
reads and pushed to OpenCode on that session's next write, then dropped from
the file; the web server sweeps the rest.

The webview answers `POST /api/openchamber/sessions/archive|unarchive` and
`GET|POST /api/openchamber/sessions/:id/metadata` through the
`api:sessions/*` bridge cases in `bridge-system-runtime.ts`, and
`bridge-proxy-runtime.ts` folds `time.archived` and not-yet-migrated metadata
onto every proxied `GET /api/session` and `GET /api/session/:id` response, the
same overlay the web proxy applies.

## Extension localization

Two bundles carry extension-host text: `package.nls*.json` for the manifest
`%token%` strings and `l10n/bundle.l10n*.json` for the `t(...)` call sites.
Every locale file must cover the full English key set with the same `{0}`
placeholders — VS Code silently falls back to English per missing key, so a
half-translated locale looks like a shipped feature. `localizationBundles.test.ts`
enforces that, and it is the check to run whenever a feature adds a new string.

The pre-bundle loading splash in `webviewHtml.ts` is separate: its strings are
inlined in the generated HTML because the splash renders before the webview
bundle loads. It picks them from OpenChamber's own saved locale
(`openchamber.i18n.v1` in webview localStorage) and, before the user has
chosen one, from VS Code's display language, which the HTML exposes as
`window.__OPENCHAMBER_HOST_LANGUAGE__`. The UI bundle reads the same value as
its default locale (`detectInitialLocale`), so a fresh install in a supported
language starts in that language on both the splash and the app. Both are only
the first paint: the interface language is a `profile` setting (`locale`), so
once the settings load, a language the person picked in any OpenChamber client
replaces it. VS Code's display language stays in effect only while no client
has saved one.

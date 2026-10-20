# Settings sections

One directory per Settings page. `shared/` holds the page chrome and controls
every page is built from; see `.agents/skills/settings-ui-patterns/SKILL.md` for
which primitive to reach for.

## Autosave on the OpenCode configuration pages

`agents/`, `commands/`, `skills/`, `mcp/`, `plugins/` and `behavior/` edit files
that OpenCode v2 watches: it picks up a change and applies it within a second or
two, and the server answers every config mutation with a plain
`{ success, message }`. There is no restart to wait for and no restart state to
show, so these pages carry no Save, Apply or Discard button.

The contract, implemented by `shared/SettingsAutosave.tsx`:

- Toggles, chips, selects, pickers and row removals write immediately. They call
  `requestSave()` right after setting state; the hook runs the save after the
  render commits, so the routine reads the value the control just set.
- Text fields write when they lose focus. `SettingsPageLayout` takes the hook's
  `onBlurCapture`, which fires for any input, textarea or editor inside the
  page, so individual fields need no handler. Long editors (the skill document,
  a plugin file) also write on Cmd/Ctrl+Enter.
- A page's save routine compares the form against what it last wrote and returns
  `AUTOSAVE_UNCHANGED`, `AUTOSAVE_SAVED` or `autosaveFailed(reason)`. Success is
  silent and there is no inline "Saving…"/"Saved" indicator: a write is not
  something the user waits for. A failure is an error toast,
  "Couldn't save: <reason>", raised by the hook itself.
- **One page, one save routine.** A section that writes its own request still
  reports through the page: `agents/AgentPermissionsEditor.tsx` hands its save
  routine to `AgentsPage` via `registerSave`, and the page's save runs it, so a
  failure is reported once.
- Saves run serially. A save request received during a write queues one follow-up
  using the latest committed form state. Unmounting prevents that follow-up.

Do not route these pages through `reportSettingsSaveState` / `showSaveStatus`.
That indicator belongs to settings persisted by `updateDesktopSettings`, and it
is deliberately silent on success.

### Reconciliation

OpenCode re-reads files after writes. Store refreshes can arrive before the
save promise settles, while the user is already editing the next version.
Commands compare incoming values with both the saved baseline and the normalized
submitted snapshot. Successful saves keep that normalized baseline for late
echoes. Agents and MCP preserve dirty drafts and their baseline during refreshes
of the same entity; successful saves advance that baseline. Skills and plugins
preserve dirty drafts while updating their server baseline. A failed write leaves
the form dirty for retry. Superseded skill detail reads are ignored.
Behavior only normalizes the submitted prompt if the user has not changed it.

Scope reconciliation to the selected entity and Settings directory. Selecting
another entity hydrates its form, and an older save completion must not replace
its baseline. Runtime endpoint changes remount Settings through the keyed
`SyncProvider` in `App.tsx`.

### Creating an entity

A new agent, command, skill or MCP server is a draft in its store, not a file.
Nothing is written while the draft is being filled in: the page shows Create and
Cancel, Create validates (name, and whatever else the entity needs) and writes
once, and Cancel drops the draft. Abandoning a half-typed entity leaves nothing
on disk. Once the entity exists, the page switches to the autosave rules above.

`skills/` follows the same split for supporting files: editing an existing file
writes when the dialog closes, while a new file is only created on confirm.

## Sync (`sync/`)

Settings → Sync (slug `sync`, Workspace group, not in VS Code) compares the
shared instance settings of every registered host and copies the chosen items
from one source host to the chosen targets. The rules, what is shared and what
never is, live in `lib/settings/DOCUMENTATION.md` (*Shared instance
settings*). `SyncPageView` takes the hosts as a prop so tests can render it
over fake hosts; `SyncPage` passes `useHostOptions()`.

## Engines (`providers/`)

The Settings page keeps the slug `providers` for deep links but is titled
Engines: one card per coding CLI the server runs (`GET /api/engines`), and a
detail page per engine. The page is not an autosave page; everything on it is
an action on the server machine. Data and requests live in
`setup-wizard/engineSetupApi.ts` and `useEngineSetupStore.ts`, which the setup
wizard shares. The API parser accepts an older server: missing `actions`,
`commands` and `installSource` fall back to `canInstall`, `installCommand` and
`packageManager`, and an install or update answered 404 on
`/actions/:action` is sent to the older `POST /:engine/install`.

`providers/engineManagement.ts` derives what the detail page offers. An action
the server marks runnable (`actions[action]`) is a button; otherwise its
`commands[action]` is shown with Copy and Run in terminal. Uninstall asks first
and sends `removeConfig` only when the user ticks it (off by default). A 400
with a command, a 409 (another job running) or a failure is kept per engine in
the store's `actionNotice`. Signing in opens `setup-wizard/EngineSignInDialog.tsx`,
the one sign-in dialog the detail page, the setup wizards and a chat's
not-signed-in error share: `POST auth/login` starts the CLI's login on the
server in the background, the dialog polls `GET auth/login`, shows Open
sign-in page for the link the server found, a device code to copy when there
is one, and a code field with Paste and Submit (`POST auth/login/input`) that
is always there while the sign-in runs. Closing it while it runs sends
`DELETE auth/login`. Raw output folds under Show raw output. A server that
cannot run it (older, or an answer without `state`) reads as failed, and the
dialog then shows the terminal command (`commands.login`, else the readiness
`fixCommand`). When it ends the engine list, sign-in and readiness are read
again. Signing out goes through `POST auth/logout` for Claude Code and Codex and
through the agy TUI for Antigravity. The sign-in line reads `GET auth/status`
when the page opens, after a terminal command ends and after sign-out.

**Which server.** With several hosts registered, a picker beside Refresh
(`providers/EngineHostPicker.tsx`, connected hosts only, the focused host by
default) chooses the server the page acts on; it is the only host picker in
Settings. `ProvidersPage` renders the page inside `HostScopeContext` of that
host and remounts it when the pick changes. `useEngineSetupStore` is a host
store whose actions run with their host ambient, so the list, every action,
sign-out and the reread after them reach the picked host;
`providers/engineHost.ts` (`useScopedHostRuntime`) gives the sign-in dialog,
the job log and the model refresh the same host. A terminal command for a
host other than the focused one focuses that host first, because the terminal
panel shows the focused host, and runs in its home folder
(`providers/engineTerminal.ts`).

The live log (`providers/engineJobStream.ts`) reads
`GET /api/engines/:engine/install/stream` through the scoped host's transport, so the UI
password, bearer tokens and the relay apply as to any other request; a closed
stream reconnects after 5 seconds. A `status` event that leaves `running`
rereads the engine list and sign-in.

Run in terminal uses `lib/runInTerminal.ts`: a project-action terminal tab in
the active project or chat folder, or the server's home folder when none is
active. It closes the setup wizard. The desktop layout also closes the
Settings dialog and opens the context panel's terminal; the phone layout
(`MobileApp`) subscribes with `subscribeWorkspaceTerminalReveal`, closes the
Settings surface and opens the workspace drawer's Terminal tab, pointed at the
home folder when that is where the command runs. Only VS Code, or a home
folder not resolved yet, falls back to Copy.

The Models section under each engine is the per-provider show/hide list
(`hiddenModels` in the UI store), unchanged from the provider page it replaced.

`providers/ProviderOAuthMethods.tsx`, `ProviderFormFields.tsx` and
`provider-oauth.ts` stay for MCP OAuth below.

### MCP OAuth

A remote MCP server with OAuth enabled is registered by OpenCode as an
integration (`mcp_<hash>`, `metadata.source: "mcp"`, named after the server)
with one `oauth` method, so signing in is the same connect / status /
complete flow OpenCode provider integrations use. `mcp/McpOAuthSignIn.tsx` looks the
integration up by server name in the server's directory (the registration is
per Location) and mounts the shared `providers/ProviderOAuthMethods.tsx`
with that directory. It appears in the status card while the server reports
`needs_auth`; once the credential is stored, the page connects the server
again, which is what moves it out of `needs_auth`.

### Sign-in hint on Usage

Usage reads the login each engine's own CLI keeps on the server machine, so
Settings has no form for it. When a provider reports not configured, the Usage
page shows `usage/CliSignInHint.tsx` in its warning: the CLI's name and the
terminal command that signs it in (`claude auth login`, `codex login`). Both
come from `QUOTA_PROVIDERS` in `lib/quota/providers/index.ts`, so a new provider
brings its own sign-in command. The user signs in on the terminal and refreshes
Usage.

### Policy-blocked MCP servers and skills

OpenCode drops an MCP server or skill an `integration.use` deny names
(`mcp:<name>`, `skill:<id>`, wildcards allowed) from its own lists, while the
MCP and Skills pages list what the config files and the disk hold.
`shared/useIntegrationPolicyBlock.ts` reads the statements from
`/api/config` (`readIntegrationPolicies`, decided like OpenCode: documents
reversed, last match wins) and the pages mark such a row "Blocked by policy";
the MCP page also disables Connect and Test. A skill's id is its `SKILL.md`
folder name, not its display name. Statements from a connected OpenCode
Console workspace are not in `/api/config`, so a server blocked only there is
not marked.

## Entity shapes: OpenCode 2 only

Every OpenCode entity these pages read and write speaks the v2 shape defined in
`packages/web/server/lib/opencode/DOCUMENTATION.md`, section "Entity routes (v2
shapes)". The server reads v1 files too and rewrites them in place as v2; the UI
only ever sends v2.

| Entity | What the page reads and writes |
|---|---|
| Agent | `system` (the markdown body), `description`, `model` as `provider/model#variant`, `mode`, `steps`, `hidden`, `color`, `request.body.temperature` / `request.body.top_p`, and an ordered `permissions` rule list |
| Command | `template` (the markdown body), `description`, `agent`, `model` with `#variant`, `subagent` |
| MCP server | `type` (required), `command` / `url`, `environment`, `headers`, `disabled`, `codemode`, `timeout: { startup, catalog, execution }`, snake_case `oauth` |
| Provider | `package` with the `aisdk:` prefix, `settings.baseURL`, `headers`, `body`, models keyed by id with `modelID`, `capabilities`, `variants`, `cost.cache.read/write`, `disabled` |
| Plugin | `{ package, options }`, serialized as a bare string when there are no options |

Two consequences worth knowing:

- **Edit the stored entry, never the resolved one.** `AgentInfo` and the model
  catalog are what OpenCode resolved: built-in defaults, global config and live
  session grants are already merged in. Writing that back would bake them into
  the file. `agents/AgentsPage.tsx` and `AgentPermissionsEditor.tsx` therefore
  read `GET /api/config/agents/:name/config` and `…/permissions`, and the
  commands store reads `GET /api/config/commands/:name/config` because the v2
  `CommandInfo` carries only a name and a description.
- **`request` is replaced wholesale.** A PATCH that sends `request` overwrites
  the whole block, so `AgentsPage` merges the fields it owns into the stored
  `request` instead of sending only what changed.

`disabled: true` is not a soft toggle: OpenCode 2 drops the entity entirely, so
no page exposes it as an on/off switch for agents. For MCP servers `disabled` is
the documented way to keep a server configured but inactive, and the page's
"Enable" checkbox writes it.

### Agent permissions

Settings lists hidden custom agents so their files remain editable, renameable, and deletable. Hidden built-in agents stay out of Settings, and all hidden agents stay out of the composer pickers. Duplicate and rename read the stored entry and preserve its `hidden` flag.

OpenCode 2 replaced the v1 `permission` map (`bash`/`task`/`list`/`lsp` keys with
allow/deny/ask per pattern) with an ORDERED list of `{ action, resource, effect }`
rules where the LAST match wins. The user does not think in ordered rules, so
the editor keeps the v1 mental model: one row per tool with inherit / allow /
ask / deny, an arrow showing what OpenCode will actually do for that tool right
now, and resource patterns under an expanded row. `agents/agentPermissionModel.ts`
translates this view to and from the rule list. Because order is part of the
policy, a save edits the stored list in place: changed effects replace their
rule where it stands, removed rows drop theirs, rules the view cannot show (an
`*` action with a resource pattern) pass through untouched, and only new rules
are inserted (agent wildcard first, a tool's wildcard before its patterns, a
pattern last), so decisions for tools the user did not touch never change. The
arrow is computed from OpenCode's built-in defaults
(`OPENCODE_DEFAULT_RULES`), the global `opencode.json` rules and the agent's
own wildcard, in that order. v1-only keys (`LEGACY_ACTIONS`) are neither shown
nor written back.

Below the built-in tools the editor lists one row per MCP server from the
Settings directory's config (`useMcpConfigStore`), keyed `<server>_*`, which
OpenCode matches against every tool the server exposes. Every configured server
is listed, not only the connected ones, so a rule can be set while a server is
disabled or failing; the live status from `useMcpStore` is shown beside the
name as a hint. A single MCP tool (`<server>_<tool>`) is still reachable
through the custom key input.

### The legacy-format note

Config reads report `legacy: true` when the entity's file still uses v1
spellings, and mutations answer with the `path` they wrote.
`shared/SettingsLegacyFormatNote.tsx` turns that into one quiet line at the top
of the page; the file is never moved, so the note has no action.

## The project page

`projects/ProjectSettingsPanel.tsx` is one project's page, shown by Settings →
Projects (`frame="page"`) and by the sidebar's project edit dialog
(`frame="dialog"`). The header holds the icon, colour and name: the icon opens a
popover with the colour (`shared/SettingsColorField.tsx`, the same field the
Agents page uses) and the symbol or image, and the name is edited in place. Below
it a tab strip splits the rest: General (new-chat defaults, the team file, trust,
plans folder), Actions (a card grid with an editor dialog), Worktrees (setup
commands and a link to the worktrees page) and Environment (not in VS Code).
Identity fields autosave through `useProjectIdentityAutoSave`, as before.

A project's setup lives in two files: the team's `.openchamber/project.json` in
the repo and the user's own config (`packages/web/server/lib/projects`). The page
shows one list per kind with every entry marked Team or Only me, and
`projects/projectSetupModel.ts` maps each edit onto the file the entry lives in:

- Team entries are edited in place, in the repo file. Nothing is copied into
  the personal file.
- A move between the files writes the destination first, then removes the
  entry from the source. A failed second write leaves the entry in both files;
  the server's merge shows it once. Every edit ends with a fresh read.
- Hiding a team action writes only the personal `hiddenSharedActionIds`.
- When the repo file exists but cannot be parsed, team writes are refused: a
  write replaces the file, so it would drop what could not be read.
- `projects/useProjectSetup.ts` reads with `fetchProjectSetup`, which throws.
  A failed read shows a retry, never an empty list that a later save would
  write back over the files.

The Settings page keeps its tab in `projects/projectSettingsTabs.ts` so a search
result can open the tab that holds its target (`prepareSettingsSearchTarget`).
The dialog keeps its own tab and starts on General every time.

Project colours are six-digit hex from the same presets as agents
(`lib/colorPresets.ts`), and an image icon takes the colour as its background
(`iconBackgroundForProjectColor`). Projects saved by older builds may carry a
theme key; `resolveProjectColor` in `lib/projectMeta.ts` still paints those,
and the colour field shows them as a selected swatch until the user picks again.

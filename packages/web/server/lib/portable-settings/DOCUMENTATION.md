# Portable settings

## Purpose

The instance settings a person carries from machine to machine: MCP servers, user-level agents and commands, user skills, Git identities, projects and their scheduled tasks. Each instance keeps them in its own files; this module lists them in one comparable form, hands out their values and writes values another instance sent. The UI copies between instances (`packages/ui/src/lib/settings/DOCUMENTATION.md`, *Shared instance settings*); instances never talk to each other.

## Files

| File | Owns |
|---|---|
| `catalog.js` | `createPortableSettingsCatalog({ categories, pathExists })`: `snapshot()`, `exportItems(refs)`, `importItems({ items, removals, force })`; fingerprints and `~` paths. |
| `categories.js` | One adapter per category: `list()` (items with key, label, value, `updatedAt`, required paths), `parse`, `requiredPaths`, `write`, `remove`, and optional `normalizeKey`, `exportRefusal`, `writeRefusal`. |
| `server-catalog.js` | The adapters wired to the real stores (`opencode/mcp.js`, `agents.js`, `commands.js`, `skills.js`, `git/identity-storage.js`, settings, `scheduled-tasks`). |
| `routes.js` | The routes, inputs parsed with zod. |

## Routes

All sit behind the UI auth guard like every other `/api` route; bodies are parsed by the common JSON middleware (`/api/portable-settings` prefix, 50 MB, for skill files).

- `GET /api/portable-settings` → `{ version: 1, categories: { [category]: { status: 'ok', items: [{ key, label, detail?, fingerprint, updatedAt, paths }] } | { status: 'error' } } }`. No values. A category that cannot be read is `error`, never an empty list.
- `POST /api/portable-settings/export` `{ items: [{ category, key }] }` (1–500) → `{ items: [{ category, key, status: 'found', value, updatedAt } | { status: 'missing' } | { status: 'refused', reason } | { status: 'failed', reason }] }`. `Cache-Control: no-store`. The answer carries secrets (MCP headers and environment); it is for the copy and is never logged.
- `PUT /api/portable-settings` `{ items?: [{ category, key, value, updatedAt? }], removals?: [{ category, key, updatedAt? }], force? }` (≤500 each) → `{ results: [{ category, key, status, reason?, path? }] }`. `status` is `applied`, `removed`, `unchanged` (same fingerprint), `skipped` (`target-newer`: this instance's copy is newer and `force` is off), `refused` (`invalid`, `path-missing` with the `path`, `project-missing`, `conflict`, `linked`) or `failed` (`error`). One item failing leaves the others written.

## Categories

| Category | Key | Value | Needs on the target | `updatedAt` |
|---|---|---|---|---|
| `mcp` | server name | the v2 entity of a user-scope entry | an absolute `command[0]` | none |
| `agents` | agent name | the canonical entity of a user `.md` agent | — | file time |
| `commands` | command name (`group/name`) | the canonical entity of a user `.md` command | — | file time |
| `skills` | skill name | `{ root: '~/.agents/skills', dir, files: [{ path, content (base64) }] }` | the skills root, for a new skill | newest file time |
| `gitIdentities` | profile id | name, author, signing; never account or managed key | a signing key given as a path | none |
| `projects` | `~/…` path (absolute outside the home folder) | label, icon, colors, default agent/model/variant | the folder | none |
| `scheduledTasks` | `<taskId>@<~ path>` | the task without its run state | the project registered on the target | task `updatedAt` |

- **Paths**: a path under the home folder travels as `~/…` and is expanded with the target's home. A missing folder refuses the item with `path-missing`; the folder is never created.
- **Exact copies**: an MCP entry is deleted and recreated, an agent or command file rewritten, a skill folder staged beside the old one and swapped in (files the source no longer has are gone), a Git identity updated with the target's own authentication kept, a project's portable fields replaced while its id, times and icon image stay.
- **Left out**: project-scope entries, agents and commands that live only in `opencode.json`, skills from caches or extra configured paths, skills over 200 files or 5 MB (`too-large` on export), linked skill folders (`linked`), a new skill whose folder name another folder already uses (`conflict`), scheduled tasks of the chats scope, ones bound to a session or driven by a loop file.
- **Keys from the UI**: export accepts a project or scheduled task by absolute path or by project id and answers with the portable key, so the fan-out never needs to know the source's home folder.

## Enterprise mode

Unchanged, with the reason: copying moves the user's own configuration between instances the user already saved and signed in to. No conversation content moves, no listener opens, and no model provider, key or endpoint is added (MCP, plugin and skill entry in Settings is outside the mode, `enterprise-mode.js`).

## Tests

`catalog.test.js` (snapshot without values, a category error, export refusals, path refusal next to a written item, newest wins unless forced, unchanged, a failed write not stopping the next, removals, values never logged), `categories.test.js` (skill copy into a fresh root, missing root, replace, path escape, conflict; MCP replace and command path; Git identity keeps authentication; projects by `~` path; scheduled tasks left out and project refusal; keys by absolute path and project id) and `routes.test.js` (input validation, no-store, values never logged) run with `bunx vitest run <file>` in `packages/web`.

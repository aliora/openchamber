# Quota Module Documentation

## Purpose
This module fetches the usage limits of the engines' own subscriptions in the web server runtime: Claude Code, Codex and Antigravity. Each provider reads the sign-in its CLI keeps on this machine. Nothing here reads OpenCode's credential store or asks the OpenChamber server for credentials.

Node server entrypoints apply `../network-defaults.js` before serving requests,
including the daemon launched directly through `server/index.js`. Connection
attempts get 5 seconds without changing address-family selection. The VS Code
extension applies the same policy in its own process at activation.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/lib/opencode/feature-routes-runtime.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration (`GET /api/quota/providers`, `GET /api/quota/:providerId`).
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/claude/`: Claude credential discovery, usage transforms, and rate-limit handling.
- `packages/web/server/lib/quota/providers/codex.js`: Codex credential read and usage mapping.
- `packages/web/server/lib/quota/providers/antigravity.js`: Antigravity usage read from the `agy` CLI.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`. Any other ID answers `ok: false`, `configured: false`, `error: Unsupported provider`.

| Provider ID | Display name | Module | Credential |
| --- | --- | --- | --- |
| `claude` | Claude | `providers/claude/` | Claude Code Keychain entry (macOS), `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`, then `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | Codex | `providers/codex.js` | `${CODEX_HOME:-~/.codex}/auth.json` (`tokens.access_token`, `tokens.account_id`) |
| `antigravity` | Antigravity | `providers/antigravity.js` | None read: the `agy` CLI answers for its own sign-in |

## Configured versus failing
A provider is **configured** when its CLI holds a sign-in on this machine. The dispatcher checks that first, through the provider's `isConfigured()`, which may return a promise:

- No sign-in, or a credential read that throws, answers `configured: false` and the provider's `fetchQuota()` never runs. The UI hides such a provider and offers sign-in guidance on its own page.
- A provider with a sign-in whose `fetchQuota()` fails (expired token, HTTP error, network) answers `configured: true`, `ok: false` and an `error`.
- `GET /api/quota/providers` lists the configured IDs. It reads local files only, so it has no failure of its own to report.

## Response contract
All providers return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional fields: `error`, `planLabel`

Provider modules export `providerId`, `providerName`, `isConfigured()`, and `fetchQuota()`.
`fetchQuota()` returns a quota result with `usage.windows` keyed by window name (for example `5h`, `7d`, `weekly`) and optional per-model `usage.models` data.

## Credentials are read-only
OpenChamber never writes to a CLI's credential store and never refreshes its OAuth token. Anthropic does not support two live refresh tokens for one client, and Codex rejects a refresh token it has already exchanged, so a refresh here would sign the user out of Claude Code or Codex. Credentials are read fresh per request so a refresh done by the CLI is picked up immediately; an expired token yields an explicit "sign in again" error rather than a bare 401. Token contents are never logged, including when a credential file is malformed.

## Claude credential and limit semantics

Claude quota reports the subscription limits Claude Code itself is bound by, read from `GET https://api.anthropic.com/api/oauth/usage`.

- **Credential sources**, in priority order: the macOS Keychain entry `Claude Code-credentials`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` (the Linux/WSL location), then `CLAUDE_CODE_OAUTH_TOKEN`. The Keychain wins on macOS because the credentials file there is a leftover Claude Code no longer updates. Without any of them the provider is not configured.
- **Limits come from the `limits` array**, keyed by `kind`: `session` maps to the `5h` window, `weekly_all` to `7d`, and `weekly_scoped` to a per-model `7d` window named by `scope.model.display_name`. The legacy `five_hour`/`seven_day` fields are only a fallback; `seven_day_sonnet`/`seven_day_opus` are no longer populated by Anthropic. Unrecognized limit kinds and Anthropic's rotating internal code names (`nimbus_quill`, `tangelo`, ...) are ignored rather than guessed at.
- **Extra usage** is reported as the `extra_usage` window from `spend`, only while `spend.enabled` is true, with a money `valueLabel`.
- **Rate limiting**: Anthropic returns 429 aggressively. The last successful usage payload is cached in memory and reserved during a cooldown (`Retry-After`, else five minutes, capped at one hour). The cache is keyed by a hash of the access and refresh tokens, so switching accounts drops it instead of showing the previous account's numbers.
- **Runtime parity**: Web/Electron and VS Code preserve the last successful Claude values during the same bounded 429 cooldown. Quota dispatchers also coalesce concurrent refreshes for the same provider in each runtime, while requests for different providers remain parallel.

## Codex credential and limit semantics

Codex quota reads `GET https://chatgpt.com/backend-api/wham/usage` with the ChatGPT sign-in Codex CLI keeps in `${CODEX_HOME:-~/.codex}/auth.json`: `tokens.access_token` as the bearer token and `tokens.account_id` as `ChatGPT-Account-Id`.

- **Not configured** when the file is missing, empty, malformed, holds an API-key login without `tokens`, or when Codex keeps its login in the OS keyring instead of the file. A 401 reports "Codex session expired. Open Codex to sign in again." since only Codex refreshes the token.
- **Windows**: `rate_limit.primary_window` and `secondary_window` are labeled from their duration (`5h`, `weekly`, other durations as `<n>d`/`<n>h`).
- **Credit balance**: `credits.balance` is an OpenAI credit count, not a dollar amount. It is exposed as a plain numeric `credits_balance.valueLabel` under the UI's localized Credits Balance title, without a currency symbol or two-decimal money rounding. Numeric strings are accepted; zero, unlimited, and unavailable balances keep their own handling. The separate business-account `spend_control.individual_limit` window is the `credits` window.
- Keep `providers/codex.js` and `packages/vscode/src/quotaProviders.ts` in sync. The VS Code extension has its own copy of this logic.

## Antigravity limit semantics

Antigravity quota is what `agy` itself reports, read through the CLI rather than any Google endpoint; OpenChamber never reads agy's token files.

- **Configured** when `agy models` lists models (`getAgyAuthStatus` in `engine/antigravity/adapter.js`). Without a sign-in no print-mode command runs, since print mode could start a sign-in.
- **Limits** come from `agy -p /usage --output-format json`, a slash command that answers without a model turn (`num_turns` 0, no tokens). Each bucket of each `command.data.groups[]` becomes the window `<group name> · <bucket window>` (`weekly` or `5h`), with `usedPercent` `(1 - remaining_fraction) * 100` and `resetAt` from `reset_time`. A bucket without a numeric fraction is skipped. The UI labels the part after ` · ` like any other window.
- **Credits**: `agy -p /credits --output-format json` gives `remaining_credits`, shown as the `credits_balance` value. A failed credits read leaves it out.
- **Caching**: the sign-in check and a successful result are kept for 60 seconds; a failed read is not cached. Each command has a 20 second limit.
- `packages/vscode/src/quotaProviders.ts` runs the same commands with the agy binary from `~/.local/bin`, `/usr/local/bin` or `%LOCALAPPDATA%\agy\bin`.

## Add a new provider (quick steps)
1. Choose module shape based on complexity:
   - Simple providers: create `packages/web/server/lib/quota/providers/<provider>.js`.
   - Providers with multi-source auth, multiple API calls, or non-trivial transforms: create `packages/web/server/lib/quota/providers/<provider>/` with split modules like Claude (`index.js`, `auth.js`, `transforms.js`).
2. Read the sign-in the provider's own CLI keeps. A missing sign-in is `null`, which reports as not configured; throw only for a failure with a sign-in present.
3. Export `providerId`, `providerName`, `isConfigured`, and `fetchQuota`.
4. Use shared helpers from `packages/web/server/lib/quota/utils/index.js` (`buildResult`, `toUsageWindow`, conversion helpers) to keep payload shape consistent.
5. Register the provider in `packages/web/server/lib/quota/providers/index.js`.
6. Mirror it in `packages/vscode/src/quotaProviders.ts` and in the UI list (`QuotaProviderId` in `packages/ui/src/types/quota.ts`, `QUOTA_PROVIDERS` in `packages/ui/src/lib/quota/providers/index.ts`).
7. Update this file with the provider ID, module path, and credential source.

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch expects exact provider IDs.

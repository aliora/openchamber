# Claude Code + subscription models: handoff

Updated: 2026-10-16. Fork: https://github.com/aliora/openchamber.
Local checkout: `C:\Users\alta\Documents\GitHub\openchamber`.

## Goal and current scope

The user wants OpenChamber to use **Claude Code as the agent runtime**, with selectable OpenAI/Codex and Antigravity models through CLIProxyAPI. Existing subscriptions are required; separate paid provider API keys are outside scope. Claude Code owns tools, permissions and the agent loop; the proxy translates model requests. Separate CLI delegation was considered but is not the selected direction.

Only a standalone MSI-PC installation/proof was performed. OpenChamber integration is **not implemented**, and the implementation design is not approved. Previous installed OpenChamber/OpenCode deployments were removed in another session; this fork is the development source.

Intended architecture:

```text
OpenChamber UI -> OpenChamber server -> Claude Code
                                      -> CLIProxyAPI
                                         -> Codex OAuth subscription
                                         -> Antigravity Google OAuth subscription
```

## Installed files and versions

- Canonical installation: `C:\Users\alta\Tools\CLIProxyAPI`
- Proxy executable: `8.0.31\cli-proxy-api.exe`; release archive SHA-256 verified.
- Claude Code tested: `2.1.224`; installed Codex CLI: `0.162.1`.
- `config.yaml`: loopback listener `127.0.0.1:8317`, management API disabled, `oauth.auth-dir` points to canonical `auth` directory.
- `auth\`: OAuth credentials; `client-key`: local proxy client authentication. This local key is not a paid upstream API key. Never copy these files or their contents into Git, chat, or this document.
- `claude-codex.cmd`: native CMD launcher; works from CMD or PowerShell. Sets environment within `setlocal`, uses existing proxy or starts it, then invokes `claude.cmd`.
- Launcher sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, clears `ANTHROPIC_API_KEY`, and maps Haiku/Sonnet/Opus default aliases to the selected model. Normal global Claude settings remain unchanged.

## Login

Run these commands in **PowerShell**. Complete the opened browser flow with the subscription-owning account.

```powershell
& 'C:\Users\alta\Tools\CLIProxyAPI\8.0.31\cli-proxy-api.exe' -config 'C:\Users\alta\Tools\CLIProxyAPI\config.yaml' -codex-login
& 'C:\Users\alta\Tools\CLIProxyAPI\8.0.31\cli-proxy-api.exe' -config 'C:\Users\alta\Tools\CLIProxyAPI\config.yaml' -antigravity-login
```

Codex OAuth succeeded. Antigravity first returned `access_denied`; a new login attempt succeeded. Both credentials are saved locally. The `agy` CLI was not used for this login; CLIProxyAPI performs its own Google OAuth flow.

## Start Claude Code with a selected model

The following commands work unchanged in **CMD and PowerShell**. Change into the target project first. The launcher defaults to `gpt-6-luna` when `-Model` is omitted.

```text
C:\Users\alta\Tools\CLIProxyAPI\claude-codex.cmd -Model gpt-6-luna
C:\Users\alta\Tools\CLIProxyAPI\claude-codex.cmd -Model gpt-6.1-sol
C:\Users\alta\Tools\CLIProxyAPI\claude-codex.cmd -Model gemini-3.8-flash-high
C:\Users\alta\Tools\CLIProxyAPI\claude-codex.cmd -Model claude-sonnet-4-6
C:\Users\alta\Tools\CLIProxyAPI\claude-codex.cmd -Model claude-opus-4-6-thinking
```

The listed GPT models route to Codex OAuth. The listed Gemini and Claude models were returned with `owned_by: antigravity`; they use the Antigravity account, not a separately configured Anthropic subscription. Names are an observed catalog snapshot, not a guarantee of successful inference. Re-read the catalog before choosing other names.

PowerShell catalog check, without printing the credential:

```powershell
$bridgeRoot = 'C:\Users\alta\Tools\CLIProxyAPI'
$bridgeHeaders = @{ Authorization = 'Bearer ' + [IO.File]::ReadAllText("$bridgeRoot\client-key").Trim() }
(Invoke-RestMethod 'http://127.0.0.1:8317/v1/models' -Headers $bridgeHeaders).data | Select-Object id, owned_by
```

## Verified results and limits

- Claude Code + `gpt-6-luna`, low effort: actual Read/Write tools read `BRIDGE_READ_OK` and wrote `BRIDGE_WRITE_OK`; resumed the same session and executed Bash `pwd && cat output.txt`. Both turns succeeded.
- Evidence in the canonical installation: `smoke-result.json`, `resume-result.json`, `smoke-test\output.txt`. Session: `ad160d58-d3f9-4895-bb24-1a7e915bafa4`.
- Smoke tests disabled hooks/MCP and preallowed only the test tools. Interactive approval handling, MCP, hooks, compaction, cancellation and reconnect remain untested. The normal launcher uses the user's usual settings.
- Antigravity: login and model discovery succeeded; no real inference/tool test yet. Sol reached the interactive workspace trust screen; no Sol model-response test was performed.
- Claude Code warns unknown models use an assumed 200k context window. Keep the default until the actual window/mapping is verified. `costUSD` in CLI output is not proof of extra API billing.
- The CLI warns claude.ai connectors are disabled when proxy authentication takes precedence.
- Reverse routing, Codex CLI -> Claude/Gemini, is a documented proxy capability but has not been configured or tested here.

## Windows path incident and remaining cleanup

Codex MSIX redirected the original `AppData\Local\CLIProxyAPI` installation into:
`C:\Users\alta\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CLIProxyAPI`.
Agent-side tests passed while the user's terminal reported “path not found”. The installation and credentials were copied to **Tools**, hashes matched, and the new launcher returned the Claude version. The original PowerShell-wrapper launcher also hit execution policy restrictions; native CMD replaced it without changing policy.

At the last process check, the live proxy still used the old configuration. A tool-policy rejection prevented its restart. Antigravity credentials were copied to both auth directories so the running proxy could discover them. Keep both copies until an intentional restart from the canonical Tools config succeeds. Before restarting, check for active user sessions. Verify the new process command line and both providers afterward. Do not treat agent-only filesystem checks as user-terminal confirmation; the user has not explicitly confirmed the new path works.

## Proposed next work, in order

1. Finish canonical-path runtime cleanup above; validate a real Antigravity turn and tool call through Claude Code.
2. Test permissions, resume, cancellation, MCP/hooks, context reporting and compaction with each intended provider. Record unsupported capabilities explicitly.
3. Inspect current fork dependencies: `packages/ui/src/lib/opencode/`, server `packages/web/server/lib/opencode/`, UI sync/state and Electron startup. Existing UI session/permission contracts depend on OpenCode; changing a URL alone is insufficient.
4. Design an OpenChamber-owned session/event interface and one Claude Code runtime adapter. Keep model-provider routing in the proxy. Define persistence, reconnect and permission reply ownership before implementation.
5. Present the scoped design for approval, then implement one end-to-end flow: create session, stream response/tools, answer permission, stop, resume. Add advanced goals/scheduling/multi-run later after agreeing scope.

This is a handoff and proposed sequence, not an approved implementation spec. Read root AGENTS.md and matching project skills before source changes. Desktop is Electron in the current fork.

References: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [release 8.0.31](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.31), [Claude gateway support and limitations](https://code.claude.com/docs/en/llm-gateway).
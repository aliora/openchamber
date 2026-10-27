# Known Issues

## 1. Scheduled tasks mark runs as `success` immediately upon prompt dispatch (`#2`)

- **Issue:** [aliora/openchamber#2](https://github.com/aliora/openchamber/issues/2)
- **Affected modules:**
  - `packages/web/server/lib/scheduled-tasks/runtime.js` (`runTask`, `runTaskWithWatchdog`, `runPrompt`)
  - `packages/web/server/lib/engine/routes.js` (`POST /api/session/:id/prompt`)
  - `packages/web/server/lib/engine/session-runtime.js` (`prompt`)
- **Symptom:** Scheduled tasks record `lastStatus: "success"` and `lastDurationMs` of ~1–2 seconds as soon as the prompt is dispatched to the session CLI process, while the agent turn is still running in the background.
- **Root cause:**
  1. `runPrompt` in `packages/web/server/lib/scheduled-tasks/runtime.js` awaits `client.session.prompt({ sessionID, text, ... })`.
  2. `runtime.prompt(...)` in `packages/web/server/lib/engine/session-runtime.js` enqueues the turn, calls `entry.process.sendUserMessage(...)`, and resolves immediately with `{ assistantMessageID }` instead of waiting for `turn.completed` (`session.execution.succeeded` / `failed` / `interrupted`).
  3. `runTask` immediately marks `status = "success"`, consumes `once` tasks (`enabled: false`), and calls `releaseRunningSlot()`.
- **Impact:**
  - Mid-turn failures (provider rate limits, crashes, `earlyoom`, or `systemd` cgroup `SIGKILL` on service restart) leave `lastStatus: "success"` and `once` tasks disabled (`enabled: false`) with no error state or retry.
  - `maxGlobalConcurrency`, `maxProjectConcurrency`, and `maxRunDurationMs` watchdog only bound the 1–2s prompt dispatch, not the actual multi-minute turn execution.
  - Child processes spawned inside a session (e.g., `nohup ... &`) stay inside `openchamber.service` cgroup and receive `SIGKILL` when the service restarts unless launched in an isolated systemd scope/unit.

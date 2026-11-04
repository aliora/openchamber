# OpenCode protocol recording

Recorded on Windows on 2026-11-04 using OpenCode CLI 2.0.31 and @opencode/client 2.0.29.

`permission-denied.json` contains a plain response followed by a rejected tool request. The terminal outcome of the rejected tool turn is `session.execution.interrupted`. Paths are redacted; configuration, credentials, instruction events and unrelated location events are excluded.

Reproduce explicitly with `node scripts/probe-opencode-engine.mjs <binary> --prompt`. The probe uses the CLI's configured default model; this recording used the free `opencode/crouton-alpha-free` model. `probe-opencode-isolation.mjs` independently checks private config/MCP headers and shared conversation storage across two processes. The engine E2E script verifies the adapter through OpenChamber routes, cards, restart/resume and cancellation.

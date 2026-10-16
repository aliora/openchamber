# OpenChamber Claude Code Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap out OpenCode completely from OpenChamber and establish a native, cross-platform (macOS, Windows, Ubuntu) Claude Code CLI engine with live bidirectional JSONL streaming, reasoning visibility, interactive permissions, and local session persistence.

**Architecture:** A native `ClaudeCodeEngine` subsystem in OpenChamber's Node.js/Bun server manages `claude` CLI processes (`--print --verbose --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompts host`), translates NDJSON events to OpenChamber UI SSE streams, handles `control_request` interactive approvals, and persists sessions to a clean local store.

**Tech Stack:** Node.js/Bun, Express, TypeScript, Vitest/Bun Test, NDJSON stream parsing, Claude Code CLI 2.1.301+, React, Zustand, Vite.

## Global Constraints

- Monorepo package manager: `bun` (version 1.3.14+).
- Node runtime: `>=24.14.0`.
- Claude Code CLI version floor: `>=2.1.224` (verified with `2.1.301`).
- Mandatory Claude CLI stream flags: `-p`, `--verbose`, `--input-format stream-json`, `--output-format stream-json`, `--include-partial-messages`, `--permission-prompts host`.
- OS targets: `win32` (Windows), `darwin` (macOS), `linux` (Ubuntu).
- Zero external OpenCode binary dependency.

---

### Task 1: Cross-Platform CLI Discovery & Process Spawner (`PlatformResolver`)

**Files:**
- Create: `packages/web/server/lib/engine/claude/platform.js`
- Test: `packages/web/server/lib/engine/claude/platform.test.js`

**Interfaces:**
- Produces:
  - `resolveClaudeExecutable(options?: { platform?: string, env?: NodeJS.ProcessEnv }): { command: string, argsPrefix?: string[] }`
  - `spawnClaudeProcess(args: string[], options: { cwd: string, env?: NodeJS.ProcessEnv }): ChildProcess`
  - `terminateClaudeProcess(child: ChildProcess): Promise<void>`

- [x] **Step 1: Write the failing unit tests for PlatformResolver**

```javascript
import { describe, it, expect } from 'bun:test';
import { resolveClaudeExecutable } from './platform.js';

describe('PlatformResolver', () => {
  it('resolves claude.cmd on Windows platform', () => {
    const res = resolveClaudeExecutable({ platform: 'win32' });
    expect(res.command).toMatch(/claude(\.cmd)?$/i);
  });

  it('resolves claude on macOS and Linux', () => {
    const macRes = resolveClaudeExecutable({ platform: 'darwin' });
    expect(macRes.command).toMatch(/claude$/);

    const linuxRes = resolveClaudeExecutable({ platform: 'linux' });
    expect(linuxRes.command).toMatch(/claude$/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/server/lib/engine/claude/platform.test.js`  
Expected: FAIL ("Cannot find module './platform.js'")

- [x] **Step 3: Implement PlatformResolver**

Create `packages/web/server/lib/engine/claude/platform.js` with cross-platform executable resolution, `spawn` options (`shell: true`, `windowsHide: true` on Windows, native POSIX on Linux/Mac), and clean SIGINT/taskkill termination.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/server/lib/engine/claude/platform.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/web/server/lib/engine/claude/platform.js packages/web/server/lib/engine/claude/platform.test.js
git commit -m "feat(engine): add cross-platform claude cli resolver"
```

---

### Task 2: Claude Code CLI Process Wrapper & NDJSON Parser (`ClaudeProcess`)

**Files:**
- Create: `packages/web/server/lib/engine/claude/claude-process.js`
- Test: `packages/web/server/lib/engine/claude/claude-process.test.js`

**Interfaces:**
- Consumes: `PlatformResolver`
- Produces:
  - `class ClaudeProcess extends EventEmitter`:
    - `constructor(options: { cwd: string, sessionId: string, model?: string, effort?: string, permissionMode?: string, resume?: boolean })`
    - `start(): Promise<void>`
    - `sendUserMessage(text: string): void`
    - `sendControlResponse(requestId: string, behavior: 'allow' | 'deny'): void`
    - `abort(): Promise<void>`
    - Events: `'init'`, `'thinking_delta'`, `'text_delta'`, `'tool_use'`, `'control_request'`, `'result'`, `'error'`, `'exit'`

- [x] **Step 1: Write unit tests for ClaudeProcess NDJSON line parser**

Test line buffering, JSON parsing of `stream_event`, `content_block_delta` (thinking & text), `control_request` (can_use_tool), and `result`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/server/lib/engine/claude/claude-process.test.js`  
Expected: FAIL

- [x] **Step 3: Implement ClaudeProcess class**

Implement child process spawning with `--print --verbose --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompts host`. Handle stdout readline, format translations, stdin writes, and error handling.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/server/lib/engine/claude/claude-process.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/web/server/lib/engine/claude/claude-process.js packages/web/server/lib/engine/claude/claude-process.test.js
git commit -m "feat(engine): add ClaudeProcess NDJSON stream manager"
```

---

### Task 3: Local Session & Message Store (`LocalSessionStore`)

**Files:**
- Create: `packages/web/server/lib/engine/claude/store.js`
- Test: `packages/web/server/lib/engine/claude/store.test.js`

**Interfaces:**
- Produces:
  - `class LocalSessionStore`:
    - `listSessions(options?: { cwd?: string }): Promise<Session[]>`
    - `getSession(id: string): Promise<Session | null>`
    - `createSession(data: { id?: string, title?: string, cwd: string, model?: string, effort?: string, permissionMode?: string }): Promise<Session>`
    - `updateSession(id: string, patch: Partial<Session>): Promise<Session>`
    - `deleteSession(id: string): Promise<boolean>`
    - `getMessages(sessionId: string): Promise<Message[]>`
    - `appendMessage(sessionId: string, message: Message): Promise<void>`
    - `appendPart(sessionId: string, messageId: string, part: Part): Promise<void>`

- [x] **Step 1: Write failing tests for LocalSessionStore**

Test session creation, listing by directory, message persistence, updating title and model, and deletion.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/server/lib/engine/claude/store.test.js`  
Expected: FAIL

- [x] **Step 3: Implement LocalSessionStore**

Persist to `~/.openchamber/data/sessions.json` with atomicity, in-memory caching, and automatic directory creation.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/server/lib/engine/claude/store.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/web/server/lib/engine/claude/store.js packages/web/server/lib/engine/claude/store.test.js
git commit -m "feat(engine): add LocalSessionStore for Claude Code sessions"
```

---

### Task 4: Interactive Control Bridge & Stream Hub (`ControlBridge` & `StreamHub`)

**Files:**
- Create: `packages/web/server/lib/engine/claude/control-bridge.js`
- Create: `packages/web/server/lib/engine/claude/stream-hub.js`
- Test: `packages/web/server/lib/engine/claude/control-bridge.test.js`

**Interfaces:**
- Consumes: `ClaudeProcess`, `LocalSessionStore`
- Produces:
  - `class ControlBridge`:
    - `handleControlRequest(sessionId: string, request: ControlRequest): Promise<{ behavior: 'allow' | 'deny' }>`
    - `resolvePendingRequest(sessionId: string, requestId: string, decision: 'allow' | 'deny'): boolean`
  - `class StreamHub`:
    - `subscribe(sessionId: string, res: Express.Response): () => void`
    - `broadcast(sessionId: string, event: EngineEvent): void`

- [x] **Step 1: Write tests for ControlBridge and StreamHub**

Test auto-allow in `bypassPermissions` mode, pending queue in `manual` mode, resolving pending approvals, and SSE broadcasting.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/server/lib/engine/claude/control-bridge.test.js`  
Expected: FAIL

- [x] **Step 3: Implement ControlBridge & StreamHub**

Implement request matching, timeout handling, and SSE header streaming (`text/event-stream`).

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/server/lib/engine/claude/control-bridge.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/web/server/lib/engine/claude/control-bridge.js packages/web/server/lib/engine/claude/stream-hub.js packages/web/server/lib/engine/claude/control-bridge.test.js
git commit -m "feat(engine): add ControlBridge and StreamHub for interactive approvals and live SSE"
```

---

### Task 5: Claude Engine REST & Auth Routes (`routes.js`)

**Files:**
- Create: `packages/web/server/lib/engine/claude/routes.js`
- Test: `packages/web/server/lib/engine/claude/routes.test.js`

**Interfaces:**
- Mounts on Express `app`:
  - `GET /api/health` -> engine status & Claude version
  - `GET /api/auth/status` -> `claude auth status --json`
  - `POST /api/auth/login` -> launch login flow
  - `POST /api/auth/logout` -> `claude auth logout`
  - `GET /api/sessions` -> session list
  - `POST /api/sessions` -> create session
  - `GET /api/sessions/:id` -> session details
  - `GET /api/sessions/:id/messages` -> session messages
  - `POST /api/sessions/:id/prompt` -> dispatch prompt to ClaudeProcess
  - `POST /api/sessions/:id/permission` -> answer permission prompt
  - `POST /api/sessions/:id/abort` -> stop current turn
  - `GET /api/stream` (or SSE on `/api/sessions/:id/stream`) -> SSE event stream

- [x] **Step 1: Write integration tests for API routes**

Mock ClaudeProcess and test session CRUD, prompt dispatch, permission reply, and auth endpoints with Supertest.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/server/lib/engine/claude/routes.test.js`  
Expected: FAIL

- [x] **Step 3: Implement Claude Engine routes**

Wire up Express router connecting `LocalSessionStore`, `ControlBridge`, `StreamHub`, and `PlatformResolver`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/server/lib/engine/claude/routes.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/web/server/lib/engine/claude/routes.js packages/web/server/lib/engine/claude/routes.test.js
git commit -m "feat(server): register Claude Code engine REST and auth routes"
```

---

### Task 6: Server Integration & OpenCode Retirement

**Files:**
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/package.json`

**Interfaces:**
- Replaces `bootstrapOpenCodeAtStartup` and `opencode-proxy.js` with `initClaudeCodeEngine`.

- [x] **Step 1: Mount ClaudeCodeEngine in server/index.js**

Add import and mount Claude routes on `/api`. Disable OpenCode child process spawning and legacy proxy middleware.

- [x] **Step 2: Run server startup test**

Run: `bun run build:web`  
Expected: SUCCESS

- [x] **Step 3: Verify clean server boot**

Start server in test mode and query `GET /api/health` and `GET /api/auth/status`. Verify 200 OK with Claude Code engine details.

- [x] **Step 4: Commit**

```bash
git add packages/web/server/index.js packages/web/package.json
git commit -m "feat(server): wire Claude Code engine into main server and retire OpenCode proxy"
```

---

### Task 7: UI Layer Alignment & Live Verification

**Files:**
- Modify: `packages/ui/src/lib/opencode/client.ts`
- Modify: `packages/ui/src/components/sections/usage/ClaudeCodeSignIn.tsx`

**Interfaces:**
- Connects UI session list, prompt sending, reasoning accordion, and tool permission dialogs to the new engine endpoints.

- [x] **Step 1: Align UI client calls with Claude Engine routes**

Ensure prompt sending, streaming events (`thinking_delta`, `tool_use`), and permission cards interact cleanly with `/api/sessions/*` and `/api/auth/*`.

- [x] **Step 2: Run type check and UI build**

Run: `bun run build:ui && bun run build:web`  
Expected: All packages compile cleanly with 0 errors.

- [x] **Step 3: Live End-to-End Test**

Run a real prompt ("Explain project structure in one sentence") through the OpenChamber server -> Claude Code CLI -> verify live reasoning, text stream, and token accounting in the UI.

- [x] **Step 4: Commit**

```bash
git add packages/ui/
git commit -m "feat(ui): align UI stores and components with native Claude Code engine"
```

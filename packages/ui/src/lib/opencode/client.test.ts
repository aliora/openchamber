import { beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification'
import { adoptRelayTunnel, deactivateRelayTunnel } from "@/lib/relay/runtime-tunnel"
import type { RelayTunnelClient } from "@/lib/relay/tunnel-client"
import { listModelVariantIds } from "@/lib/modelVariants"
import { buildSessionContextUsage } from "@/stores/utils/tokenUtils"
import type { MessagePage, ProviderCatalog } from "./client"
import { partIds } from "./model"
import { renderedPage } from "./tools"

// The generated `@opencode/client` runs for real here; only the runtime
// transport (`runtimeFetch`) and runtime identity are replaced. That keeps
// request fidelity (paths, query, headers, bodies) under test rather than
// whatever a hand-written SDK stub would accept.

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type CapturedRequest = {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

const requests: CapturedRequest[] = []
const responses: Array<Response | Error | ((request: CapturedRequest) => Response | Error | Promise<Response | Error>)> = []
let runtimeKey = "test-runtime"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const noContent = () => new Response(null, { status: 204 })

const runtimeFetchMock = mock<RuntimeFetch>(async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, "http://runtime.test")
  const request: CapturedRequest = {
    url,
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }
  requests.push(request)
  const next = responses.shift()
  const resolved = typeof next === "function" ? await next(request) : next
  if (resolved instanceof Error) throw resolved
  if (resolved === HANG) return hangUntilAborted(init?.signal ?? undefined)
  return resolved ?? json({})
})

/** Sentinel response: the transport never answers, only an abort ends the wait. */
const HANG = new Response(null, { status: 599 })
const hangUntilAborted = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    if (!signal) return
    // A real pending request keeps the event loop alive. AbortSignal.timeout does
    // not, and Bun on Windows then never fires it, so hold the loop until abort.
    const pending = setInterval(() => undefined, 1_000)
    const abort = () => {
      clearInterval(pending)
      reject(new DOMException("Aborted", "AbortError"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })

;(mock as unknown as { restore?: () => void }).restore?.()

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}))

mock.module("@/lib/runtime-url", () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: () => "http://runtime.test/api",
  })),
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: mock(() => ""),
  getRuntimeKey: mock(() => runtimeKey),
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: runtimeFetchMock,
}))

mock.module("@/lib/startupTrace", () => ({
  markStartupTrace: mock(() => undefined),
}))

const { OpencodeApiError, createRuntimeOpencodeClient, opencodeClient } = await import(`./client?client-test=${Date.now()}`)
const { readProjectConfigError } = await import("./configError")

const sessionInfo = {
  id: "ses_1",
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "First",
  location: { directory: "/repo/app" },
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  runtimeKey = "test-runtime"
  opencodeClient.setDirectory(undefined)
  opencodeClient.clearConfigCache()
})

describe('runtime routing responses', () => {
  const routingFailureSchema = z.object({ message: z.string(), status: z.number() })
  const html = () => new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const rejectedMessage = async (params: Parameters<typeof opencodeClient.sendMessage>[0]) => {
    try {
      await opencodeClient.sendMessage(params)
    } catch (error) {
      return { error, data: routingFailureSchema.parse(error) }
    }
    throw new Error('Expected the prompt to be rejected')
  }

  test('rejects an HTML prompt acknowledgement as a definite failure', async () => {
    responses.push(html())
    const error = await rejectedMessage({ id: 'ses_1', providerID: 'routing-html', text: 'hello' })
    expect(error.error).toBeInstanceOf(OpencodeApiError)
    expect(error.data.message).toContain('returned a web page instead of an API response')
    expect(error.data.status).toBe(200)
    expect(isAmbiguousSendFailure(error.error)).toBe(false)
  })

  test('rejects an HTML slash-command acknowledgement', async () => {
    responses.push(html())
    await expect(opencodeClient.sendCommand({ id: 'ses_1', command: 'review' })).rejects.toThrow('returned a web page instead of an API response')
  })

  test('does not cache an HTML configuration response', async () => {
    responses.push(html())
    await expect(opencodeClient.getConfig('/repo/html')).rejects.toThrow('returned a web page instead of an API response')
    responses.push(json([]))
    expect(await opencodeClient.getConfig('/repo/html')).toEqual({})
    expect(requests).toHaveLength(2)
  })

  test('a packaged routing 503 is definite and never trips the provider circuit', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(new Response('{"error":{"code":"runtime_unavailable"}}', {
        status: 503, headers: { 'content-type': 'application/json', 'x-openchamber-error': 'runtime-unavailable' },
      }))
      const error = await rejectedMessage({ id: 'ses_1', providerID: 'routing-unavailable', text: 'hello' })
      expect(error.data.message).toContain('runtime_unavailable')
      expect(error.data.status).toBe(503)
      expect(isAmbiguousSendFailure(error.error)).toBe(false)
    }
    responses.push(json({ data: { id: 'msg_accepted' } }))
    expect(await opencodeClient.sendMessage({ id: 'ses_1', providerID: 'routing-unavailable', text: 'hello', messageId: 'msg_accepted' })).toBe('msg_accepted')
    expect(requests).toHaveLength(7)
  })
})

describe("request fidelity", () => {
  test("project creation uses the OpenChamber directory route", async () => {
    responses.push(json({ success: true, restarted: false, path: "/repo/new" }))
    expect(await opencodeClient.createDirectory("/repo/new", { asProject: true }))
      .toEqual({ success: true, path: "/repo/new" })
    expect(requests[0].url.pathname).toBe("/api/openchamber/directory")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ path: "/repo/new", create: true })
  })

  test("project activation uses the OpenChamber directory route without creation", async () => {
    const result = { success: true, restarted: false, path: "/repo/existing" }
    responses.push(json(result))
    expect(await opencodeClient.setOpenCodeWorkingDirectory("/repo/existing")).toEqual(result)
    expect(requests[0].url.pathname).toBe("/api/openchamber/directory")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ path: "/repo/existing" })
  })

  test("a directory-scoped call carries the encoded directory header and lists that directory", async () => {
    responses.push(json({ data: [sessionInfo], cursor: { next: "c2" } }))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app dir" })
    const request = requests[0]
    expect(request.url.origin + request.url.pathname).toBe("http://runtime.test/api/session")
    expect(request.url.searchParams.get("directory")).toBe("/repo/app dir")
    expect(request.url.searchParams.get("limit")).toBe("100")
    expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/app dir"))
    expect(page.sessions[0]).toMatchObject({ id: "ses_1", directory: "/repo/app", title: "First" })
    expect(page.cursor).toEqual({ next: "c2" })
  })

  test("a session created on an explicit Default thinking level is created without a variant", async () => {
    responses.push(json({ data: sessionInfo }))
    await opencodeClient.createSession({ model: { id: "gpt-5.6-luna", providerID: "openai", variant: null } }, "/repo/app")
    expect(requests[0].url.pathname).toBe("/api/session")
    const { model } = z.object({ model: z.record(z.string(), z.string()) }).parse(requests[0].body)
    expect(model).toEqual({ id: "gpt-5.6-luna", providerID: "openai" })
  })

  test("releasing a location names its directory, never OpenCode's own", async () => {
    opencodeClient.setDirectory("/repo/current")
    responses.push(noContent())
    await opencodeClient.releaseLocation("/chats/2026-10-03/session-a b")
    expect(requests[0].url.pathname).toBe("/api/debug/location")
    expect(requests[0].method).toBe("DELETE")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/chats/2026-10-03/session-a b"))

    await expect(opencodeClient.releaseLocation("")).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test("a global list sends no directory scope at all", async () => {
    opencodeClient.setDirectory("/repo/app")
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ global: true })
    expect(requests[0].url.searchParams.has("directory")).toBe(false)
    expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
  })

  test("the active-session snapshot is the host's, except for a directory inside an isolated space", async () => {
    responses.push(json({ data: { ses_host: { type: "running" } } }))
    await opencodeClient.getActiveSessionStatuses("/repo/app")
    expect(requests[0].url.pathname).toBe("/api/session/active")
    expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
    responses.push(json({ data: { ses_space: { type: "running" } } }))
    const statuses = await opencodeClient.getActiveSessionStatuses("/spaces/a1b2c3d4e5f6/app")
    // The space's directory travels on the request; `runtimeFetch` turns it into the space's prefix.
    expect(requests[1].url.pathname).toBe("/api/session/active")
    expect(requests[1].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/spaces/a1b2c3d4e5f6/app"))
    expect(statuses).toEqual({ ses_space: { type: "busy" } })
  })

  test("a global page carries the isolated-space marks the host merged in, a directory page never does", async () => {
    const spaces = [{ id: "a1b2c3d4e5f6", name: "One", state: "stale", sessions: 1, projectDirectory: "/repo/app", directory: "/spaces/a1b2c3d4e5f6/app" }]
    responses.push(json({ data: [], cursor: {}, spaces }))
    const page = await opencodeClient.listSessionsPage({ global: true })
    expect(page.spaces).toEqual([{ id: "a1b2c3d4e5f6", name: "One", state: "stale", projectDirectory: "/repo/app", directory: "/spaces/a1b2c3d4e5f6/app" }])
    responses.push(json({ data: [], cursor: {}, spaces }))
    expect((await opencodeClient.listSessionsPage({ directory: "/repo/app" })).spaces).toBeUndefined()
    // A mark the client cannot read is no mark, not a broken list.
    responses.push(json({ data: [], cursor: {}, spaces: [{ id: "bad" }] }))
    expect((await opencodeClient.listSessionsPage({ global: true })).spaces).toBeUndefined()
  })
test('Windows drive roots remain absolute in directory selection and SDK client identity', () => {
  const previous = opencodeClient.getDirectory();
  try {
    opencodeClient.setDirectory('c:\\');
    expect(opencodeClient.getDirectory()).toBe('C:/');
    expect(opencodeClient.getScopedSdkClient('c:\\')).toBe(opencodeClient.getScopedSdkClient('C:/'));
    expect(opencodeClient.getScopedSdkClient('C:/')).not.toBe(opencodeClient.getScopedSdkClient('C:'));
  } finally {
    opencodeClient.setDirectory(previous);
  }
});

test('Windows separators and UNC representations share SDK clients without lowercasing directory names', () => {
  expect(opencodeClient.getScopedSdkClient('c:\\Users\\Developer\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('C:/Users/Developer/Project'));
  expect(opencodeClient.getScopedSdkClient('\\\\Server\\Share\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('//Server/Share/Project'));
  expect(opencodeClient.getScopedSdkClient('/repo/Project'))
    .not.toBe(opencodeClient.getScopedSdkClient('/repo/project'));
});

test('a drive-root system-info fallback stays absolute', async () => {
  responses.push(json({ directory: 'C:/', project: { id: 'project', directory: 'C:/', canonical: 'C:/' } }));
  expect((await opencodeClient.getSystemInfo()).homeDirectory).toBe('C:/');
});

  test("the current directory scopes calls that pass none", async () => {
    opencodeClient.setDirectory("/repo/current")
    responses.push(json({ location: {}, data: [] }))
    await opencodeClient.listAgents()
    expect(requests[0].url.pathname).toBe("/api/agent")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/current"))
  })

  test("invalidating an agent list starts a new request without letting the old request clear it", async () => {
    const wireAgent = (id: string) => ({
      id,
      name: id,
      mode: "subagent",
      request: { settings: {}, headers: {}, body: {} },
      hidden: false,
      permissions: [],
    })
    let releaseFirst: (response: Response) => void = () => undefined
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    responses.push(() => firstResponse)

    const first = opencodeClient.listAgents("/repo/agents")
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    opencodeClient.invalidateAgentList("/repo/agents")
    responses.push(json({ location: {}, data: [wireAgent("new-agent")] }))
    const fresh = opencodeClient.listAgents("/repo/agents")
    expect(requests).toHaveLength(2)

    releaseFirst(json({ location: {}, data: [wireAgent("old-agent")] }))
    expect((await first)[0]?.name).toBe("old-agent")
    expect((await fresh)[0]?.name).toBe("new-agent")
  })
})

describe("error normalisation", () => {
  test("an invalid project config keeps its path and message reachable", async () => {
    const body = {
      name: "ConfigInvalidError",
      data: { path: "/repo/bad/opencode.json", message: "bad file reference: {file:./.secrets/token} does not exist" },
    }
    responses.push(json(body, 400))
    const error = await opencodeClient.listAgents("/repo/bad").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(readProjectConfigError(error)).toEqual({
      name: "ConfigInvalidError",
      path: "/repo/bad/opencode.json",
      message: "bad file reference: {file:./.secrets/token} does not exist",
    })
  })

  test("a tagged error body gets its HTTP status restored", async () => {
    responses.push(json({ _tag: "SessionNotFoundError", sessionID: "ses_x", message: "no such session" }, 404))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({ status: 404, tag: "SessionNotFoundError", operation: "session.get" })
  })

  // Only routes that declare a 500 body deliver it: the generated client
  // cancels an undeclared status' body and reports the status alone.
  test("a declared 500 body keeps the log ref OpenCode printed next to its stack", async () => {
    responses.push(json({ _tag: "UnknownError", message: "Unexpected server error. Check server logs for details.", ref: "err_07817ddc" }, 500))
    const error = await opencodeClient.getSessionMessages("ses_x", { limit: 10 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({
      status: 500,
      tag: "UnknownError",
      ref: "err_07817ddc",
      detail: "Unexpected server error. Check server logs for details.",
    })
  })

  test("an undeclared 500 arrives without its body, so no ref can be quoted", async () => {
    responses.push(json({ _tag: "UnknownError", message: "boom", ref: "err_07817ddc" }, 500))
    const error = await opencodeClient.renameSession("ses_x", "Title").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({ status: 500, operation: "session.update", ref: undefined })
  })

  test("an undeclared status is reported with that status", async () => {
    responses.push(new Response("boom", { status: 500 }))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 500, operation: "session.get" })
  })

  test("a transport failure has no status", async () => {
    responses.push(new TypeError("Failed to fetch"))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect((error as { status?: number }).status).toBeUndefined()
  })

  test("fetchPermission maps 404 to resolved and everything else to unknown", async () => {
    responses.push(json({ _tag: "PermissionNotFoundError", message: "gone" }, 404))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toEqual({ state: "resolved" })
    responses.push(new Response("", { status: 502 }))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toEqual({ state: "unknown" })
    responses.push(json({ data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] } }))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toMatchObject({
      state: "ok",
      permission: { id: "per_1", action: "bash" },
    })
    expect(requests[0].url.pathname).toBe("/api/session/ses_1/permission/per_1")
  })
})

describe("sendMessage", () => {
  test("switches model and agent, admits context as synthetic messages, then prompts", async () => {
    responses.push(noContent(), noContent(), json({ id: "syn_1" }), json({ id: "msg_1" }))
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      model: { id: "gpt-5.6-luna", providerID: "openai" },
      agent: "build",
      text: "hello",
      messageId: "msg_1",
      context: [{ text: "selected code", metadata: { openchamberContext: { kind: "file-quote" } } as never }],
      agentMentions: [{ name: "explore", source: { value: "@explore", start: 0, end: 8 } }],
      directory: "/repo/app",
    })
    expect(id).toBe("msg_1")
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/session/ses_1/synthetic",
      "POST /api/session/ses_1/prompt",
    ])
    expect(requests[0].body).toEqual({ model: { id: "gpt-5.6-luna", providerID: "openai" } })
    expect(requests[2].body).toMatchObject({ text: "selected code", resume: false, metadata: { openchamberContext: { kind: "file-quote" } } })
    expect(requests[3].body).toEqual({
      id: "msg_1",
      text: "hello",
      agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }],
    })
    expect(requests.every((r) => r.headers.get("x-opencode-directory") === encodeURIComponent("/repo/app"))).toBe(true)
  })

  test("context ids travel with the synthetic messages and sort below the prompt id", async () => {
    responses.push(json({ id: "a" }), json({ id: "b" }), json({ id: "c" }))
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "",
      context: [{ id: "msg_given", text: "first" }, { text: "second" }],
    })
    const [first, second] = requests.slice(0, 2).map((request) => request.body)
    expect(first).toMatchObject({ id: "msg_given", text: "first" })
    expect(second).toMatchObject({ text: "second" })
    const mintedID = z.object({ id: z.string().startsWith("msg_") }).parse(second).id
    expect(mintedID < id).toBe(true)
  })

  test("without a selection change only the prompt is sent, with files as URIs", async () => {
    responses.push(json({ id: "msg_2" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "look",
      messageId: "msg_2",
      files: [{ type: "file", mime: "text/markdown", filename: "notes.md", url: "data:text/markdown;base64,QQ==" }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({
      id: "msg_2",
      text: "look",
      files: [{ uri: "data:text/plain;base64,QQ==", name: "notes.md" }],
    })
  })

  // OpenCode's `ModelRef.variant` is an optional string: a `null` is a 400
  // ("Expected string at [model][variant]") and the prompt never goes out.
  test("an explicit Default thinking level switches the model without a variant, never as null", async () => {
    responses.push(noContent(), json({ id: "msg_3" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      model: { id: "gpt-5.6-luna", providerID: "openai", variant: null },
      text: "hello",
      messageId: "msg_3",
    })
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/prompt",
    ])
    expect(requests[0].body).toEqual({ model: { id: "gpt-5.6-luna", providerID: "openai" } })
  })

  test("a chosen thinking level travels with the model switch", async () => {
    responses.push(noContent(), json({ id: "msg_4" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      model: { id: "gpt-5.6-luna", providerID: "openai", variant: "high" },
      text: "hello",
      messageId: "msg_4",
    })
    expect(requests[0].body).toEqual({ model: { id: "gpt-5.6-luna", providerID: "openai", variant: "high" } })
  })

  test("refuses to send when the runtime changed underneath the caller", async () => {
    await expect(
      opencodeClient.sendMessage({ runtimeKey: "other", id: "ses_1", providerID: "openai", text: "x" }),
    ).rejects.toThrow("runtime changed")
    expect(requests).toHaveLength(0)
  })

  // A runtime switch while the model switch is in flight: the agent switch,
  // context and prompt must not go to the new server.
  test("stops between the model and agent switch when the runtime changes mid-send", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        text: "hello",
        context: [{ text: "ctx" }],
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model"])
  })

  test("stops before the prompt when the runtime changes after the agent switch", async () => {
    responses.push(noContent(), () => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        text: "hello",
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model", "/api/session/ses_1/agent"])
  })

  test("stops between context messages when the runtime changes", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return json({ id: "syn_1" })
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        text: "hello",
        context: [{ text: "one" }, { text: "two" }],
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/synthetic"])
  })
})

describe("sendMessage with inline skills", () => {
  const skillInfo = (id: string, name = id) => ({ id, name, path: `/skills/${id}/SKILL.md`, content: "body" })
  const instructionFor = (names: readonly string[]) => (names.length ? `use: ${names.join(",")}` : null)

  test("attaches known skills to the prompt by id, without an instruction", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy"), skillInfo("code-audit", "audit")] }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "/audit then /deploy",
      messageId: "msg_1",
      delivery: "steer",
      directory: "/repo/app",
      skills: { names: ["audit", "deploy"], instructionFor },
    })
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["GET /api/skill", "POST /api/session/ses_1/prompt"])
    expect(requests[1].body).toEqual({
      id: "msg_1",
      text: "/audit then /deploy",
      skills: [{ id: "code-audit" }, { id: "deploy" }],
      delivery: "steer",
    })
  })

  test("names OpenCode does not list fall back to an instruction admitted before the prompt", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }), json({ id: "syn_1" }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy", "ghost"], instructionFor },
    })
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/synthetic", "/api/session/ses_1/prompt"])
    expect(requests[1].body).toMatchObject({ text: "use: ghost", resume: false })
    expect(requests[2].body).toMatchObject({ skills: [{ id: "deploy" }] })
  })

  test("a failed skill list still sends, naming every skill in the instruction", async () => {
    responses.push(json({ _tag: "UnknownError", message: "boom" }, 500), json({ id: "syn_1" }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy"], instructionFor },
    })
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/synthetic", "/api/session/ses_1/prompt"])
    expect(requests[1].body).toMatchObject({ text: "use: deploy" })
    const promptBody = requests[2].body
    expect(typeof promptBody === "object" && promptBody !== null && "skills" in promptBody).toBe(false)
  })

  test("a skill removed before the prompt resends the same message with the instruction", async () => {
    responses.push(
      json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }),
      json({ _tag: "InvalidRequestError", message: "Skill not found: deploy", field: "skills" }, 400),
      json({ id: "syn_1" }),
      json({ id: "msg_1" }),
    )
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy"], instructionFor },
    })
    expect(id).toBe("msg_1")
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/skill",
      "/api/session/ses_1/prompt",
      "/api/session/ses_1/synthetic",
      "/api/session/ses_1/prompt",
    ])
    expect(requests[1].body).toMatchObject({ id: "msg_1", skills: [{ id: "deploy" }] })
    expect(requests[2].body).toMatchObject({ text: "use: deploy" })
    expect(requests[3].body).toEqual({ id: "msg_1", text: "x" })
  })

  test("other prompt rejections are not retried", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }), json({ _tag: "InvalidRequestError", message: "Attachment too big", field: "files" }, 400))
    await expect(
      opencodeClient.sendMessage({ id: "ses_1", providerID: "openai", text: "x", skills: { names: ["deploy"], instructionFor } }),
    ).rejects.toThrow()
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/prompt"])
  })
})

describe("sendCommand", () => {
  test("switches model and agent, then runs the command", async () => {
    responses.push(noContent(), noContent(), noContent())
    await opencodeClient.sendCommand({
      runtimeKey: "test-runtime",
      id: "ses_1",
      model: { id: "m", providerID: "openai" },
      agent: "build",
      command: "review",
      arguments: "src",
    })
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/session/ses_1/model",
      "/api/session/ses_1/agent",
      "/api/session/ses_1/command",
    ])
    expect(requests[2].body).toMatchObject({ name: "review", text: "src" })
  })

  test("stops after the model switch when the runtime changes mid-command", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendCommand({
        runtimeKey: "test-runtime",
        id: "ses_1",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        command: "review",
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model"])
  })

  test("stops before the command when the runtime changes after the agent switch", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendCommand({ runtimeKey: "test-runtime", id: "ses_1", agent: "build", command: "review" }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/agent"])
  })
})

describe("messages and config", () => {
  test("getSessionMessages projects a page into domain messages and parts", async () => {
    responses.push(
      json({
        data: [
          { id: "msg_u", type: "user", time: { created: 1 }, text: "hi" },
          {
            id: "msg_a",
            type: "assistant",
            time: { created: 2, completed: 3 },
            agent: "build",
            model: { id: "m", providerID: "p" },
            content: [{ type: "text", text: "hello" }],
          },
        ],
        cursor: { previous: "p1" },
      }),
    )
    const page = await opencodeClient.getSessionMessages("ses_1", { limit: 20, order: "asc" })
    expect(requests[0].url.pathname).toBe("/api/session/ses_1/message")
    expect(requests[0].url.searchParams.get("limit")).toBe("20")
    expect(requests[0].url.searchParams.get("order")).toBe("asc")
    expect(page.items.map((item: { info: { role: string } }) => item.info.role)).toEqual(["user", "assistant"])
    expect(page.items[0].parts[0]).toMatchObject({ type: "text", text: "hi", id: "msg_u:text:0" })
    expect(page.items[1].parts[0]).toMatchObject({ type: "text", text: "hello", id: "msg_a:text:0" })
    expect(page.cursor).toEqual({ previous: "p1" })
  })

  test("a page shorter than the limit drops the next cursor the server still attaches", async () => {
    responses.push(json({
      data: [{ id: "msg_only", type: "user", time: { created: 1 }, text: "hi" }],
      cursor: { previous: "p1", next: "n1" },
    }))
    const short = await opencodeClient.getSessionMessages("ses_1", { limit: 20 })
    expect(short.cursor).toEqual({ previous: "p1" })

    responses.push(json({
      data: [{ id: "msg_only", type: "user", time: { created: 1 }, text: "hi" }],
      cursor: { previous: "p1", next: "n1" },
    }))
    const full = await opencodeClient.getSessionMessages("ses_1", { limit: 1 })
    expect(full.cursor).toEqual({ previous: "p1", next: "n1" })
  })

  test("asks for shelled pages only from a server that lists the capability, and stops when the header is refused", async () => {
    const pageRequests = () => requests.filter((request) => request.url.pathname === "/api/session/ses_1/message")
    const learnCapability = async (capabilities: string[]) => {
      responses.push(json({ compatibility: { capabilities } }))
      opencodeClient.learnMessagePageShellsSupport()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    runtimeKey = "shells-old-server"
    await learnCapability(["api.health.v1"])
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.getSessionMessages("ses_1", { limit: 20, partShells: true })
    expect(pageRequests().map((request) => request.headers.get("x-openchamber-part-shells"))).toEqual([null])

    requests.length = 0
    runtimeKey = "shells-refused-header"
    await learnCapability(["api.message-part-shells.v1"])
    // The first page's header is refused on the way (CORS, a proxy); the
    // plain page works, so later pages are plain too.
    responses.push(new TypeError("Failed to fetch"), json({ data: [], cursor: {} }), json({ data: [], cursor: {} }))
    await opencodeClient.getSessionMessages("ses_1", { limit: 20, partShells: true })
    await opencodeClient.getSessionMessages("ses_1", { limit: 20, partShells: true })
    expect(pageRequests().map((request) => request.headers.get("x-openchamber-part-shells"))).toEqual(["v1", null, null])
  })

  test("a page lost to a relay tunnel drop keeps asking for shelled pages", async () => {
    const pageRequests = () => requests.filter((request) => request.url.pathname === "/api/session/ses_1/message")
    runtimeKey = "shells-relay"
    responses.push(json({ compatibility: { capabilities: ["api.message-part-shells.v1"] } }))
    opencodeClient.learnMessagePageShellsSupport()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tunnel: RelayTunnelClient = {
      async fetch() { throw new Error("the client routes through runtimeFetch") },
      openWebSocket() { throw new Error("no sockets here") },
      getStatus: () => ({ state: "connected" }),
      subscribeStatus: () => () => undefined,
      retry: () => undefined,
      close: () => undefined,
    }
    adoptRelayTunnel({ relayUrl: "wss://relay.test", serverId: "fixture", hostEncPubJwk: {} }, tunnel)
    try {
      responses.push(new Error("relay tunnel reset: relay keepalive timeout"), json({ data: [], cursor: {} }))
      await expect(opencodeClient.getSessionMessages("ses_1", { limit: 20, partShells: true })).rejects.toThrow("transport failure")
      await opencodeClient.getSessionMessages("ses_1", { limit: 20, partShells: true })
      expect(pageRequests().map((request) => request.headers.get("x-openchamber-part-shells"))).toEqual(["v1", "v1"])
    } finally {
      deactivateRelayTunnel()
    }
  })

  test("a cursor is never combined with an order", async () => {
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.getSessionMessages("ses_1", { cursor: "abc", order: "asc" })
    expect(requests[0].url.searchParams.get("cursor")).toBe("abc")
    expect(requests[0].url.searchParams.has("order")).toBe(false)
  })

  test("getConfig folds documents and serves the fold from cache", async () => {
    responses.push(
      json([
        { type: "document", path: "/g.json", info: { model: "a", agents: { build: {} } } },
        { type: "document", path: "/p.json", info: { model: "b" } },
      ]),
    )
    const first = await opencodeClient.getConfig("/repo/app")
    const second = await opencodeClient.getConfig("/repo/app")
    expect(first).toEqual({ model: "b", agents: { build: {} } })
    expect(second).toBe(first)
    expect(requests).toHaveLength(1)
  })

  test("getProvidersForConfig gathers providers, models, and the default", async () => {
    responses.push(
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
    )
    const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
    expect(catalog.providers).toEqual([{ id: "openai", name: "OpenAI" }])
    expect(catalog.models).toHaveLength(1)
    expect(catalog.default).toEqual({ id: "x", providerID: "openai" })
  })

  for (const { label, variants } of [
    { label: "missing", variants: undefined },
    { label: "null", variants: null },
    { label: "keyed object", variants: { default: {} } },
  ]) {
    test(`a live model catalog with ${label} variants can be read by the chat renderer`, async () => {
      const model = { id: "opencode-go/glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "opencode-go", variants }
      const answer = (request: CapturedRequest) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "opencode-go", name: "OpenCode Go" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [model] })
            : json({ location: {}, data: model })
      responses.push(answer, answer, answer)

      const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
      expect(catalog.models[0]?.variants.map((variant: { id: string }) => variant.id) ?? []).toEqual([])
      expect(catalog.models[0]).toEqual({ ...model, variants: [] })
    })
  }

  test("a live model catalog keeps variant ids and settings from valid arrays", async () => {
    const variants = [{ id: "high", settings: { reasoningEffort: "high" } }, { id: "low", settings: {} }]
    const model = { id: "opencode-go/glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "opencode-go", variants }
    const answer = (request: CapturedRequest) =>
      request.url.pathname === "/api/provider"
        ? json({ location: {}, data: [] })
        : request.url.pathname === "/api/model"
          ? json({ location: {}, data: [model] })
          : json({ location: {}, data: model })
    responses.push(answer, answer, answer)

    const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
    expect(catalog.models[0]?.variants.map((variant: { id: string }) => variant.id)).toEqual(["high", "low"])
    expect(catalog.models[0]).toEqual(model)
  })

  test("providers are asked only after the models answered", async () => {
    // OpenCode 2.0.27+ holds the model routes until the directory's plugins are
    // active; a provider read sent alongside answers before them, empty.
    const answer = (request: CapturedRequest) =>
      request.url.pathname === "/api/provider"
        ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
        : request.url.pathname === "/api/model"
          ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
          : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } })
    responses.push(answer, answer, answer)
    const before = requests.length

    await opencodeClient.getProvidersForConfig("/repo/app")
    expect(requests.slice(before).map((request) => request.url.pathname)).toEqual([
      "/api/model",
      "/api/model/default",
      "/api/provider",
    ])
  })

  test("a fresh provider read waits out the one in flight and reads again", async () => {
    const answer = (request: CapturedRequest) =>
      request.url.pathname === "/api/provider"
        ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
        : request.url.pathname === "/api/model"
          ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
          : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } })
    responses.push(answer, answer, answer, answer, answer, answer)
    const before = requests.length

    const first = opencodeClient.getProvidersForConfig("/repo/app")
    const joined = opencodeClient.getProvidersForConfig("/repo/app")
    const fresh = opencodeClient.getProvidersForConfig("/repo/app", { fresh: true })
    const [firstCatalog, joinedCatalog, freshCatalog] = await Promise.all([first, joined, fresh])

    // One catalog read is three requests: the joined call adds none, the fresh one three more.
    expect(requests.length - before).toBe(6)
    expect(joinedCatalog).toBe(firstCatalog)
    expect(freshCatalog).not.toBe(firstCatalog)
  })
})

describe("providers of an isolated space", () => {
  test("are the host's, asked with no directory, while models come from the space", async () => {
    const space = "/spaces/a1b2c3d4e5f6/app"
    const answer = (request: CapturedRequest) =>
      request.url.pathname.endsWith("/provider")
        ? json({ location: {}, data: [{ id: "anthropic", name: "Anthropic" }] })
        : request.url.pathname.endsWith("/model")
          ? json({ location: {}, data: [{ id: "anthropic/x", modelID: "x", providerID: "anthropic" }] })
          : json({ location: {}, data: { id: "anthropic/x", modelID: "x", providerID: "anthropic" } })
    responses.push(answer, answer, answer)
    const before = requests.length
    const catalog = await opencodeClient.getProvidersForConfig(space)
    expect(catalog.providers).toEqual([{ id: "anthropic", name: "Anthropic" }])
    const made = requests.slice(before)
    const provider = made.find((request) => request.url.pathname.endsWith("/provider"))
    const model = made.find((request) => request.url.pathname.endsWith("/model"))
    // The host refuses its provider routes across the boundary, and a space directory without the
    // prefix; the provider list names neither.
    expect(provider?.url.pathname).toBe("/api/provider")
    expect(provider?.headers.get("x-opencode-directory")).toBeNull()
    expect(provider?.url.searchParams.get("directory")).toBeNull()
    expect(model?.url.pathname.includes("/spaces/a1b2c3d4e5f6/") || model?.headers.get("x-opencode-directory") === encodeURIComponent(space)).toBe(true)
  })
})

describe("read timeouts (#2470)", () => {
  test("a hanging read fails after the timeout while a POST is left alone", async () => {
    const client = createRuntimeOpencodeClient({ baseUrl: "http://runtime.test/api", requestTimeoutMs: 20 })
    responses.push(HANG)
    // The raw client reports transport failures as ClientError("Transport") with the cause attached.
    const failure = await client.server.info().catch((error: Error) => error)
    expect(failure).toMatchObject({ reason: "Transport", cause: { message: "OpenCode request timed out after 20ms" } })

    let settled = false
    responses.push(HANG)
    void client.session.interrupt({ sessionID: "ses_1" }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(settled).toBe(false)
  })
})

describe("sendCommand context", () => {
  test("delivers attached context as non-resuming synthetic messages before the command", async () => {
    responses.push(new Response(null, { status: 204 })) // model switch
    responses.push(new Response(null, { status: 204 })) // agent switch
    responses.push(json({ data: { id: "msg_ctx" } })) // synthetic
    responses.push(new Response(null, { status: 204 })) // command
    await opencodeClient.sendCommand({
      id: "ses_1",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
      command: "review",
      arguments: "src",
      context: [{ text: "quoted selection", description: "Selection" }],
    })
    const paths = requests.map((request) => request.url.pathname)
    expect(paths.at(-2)).toBe("/api/session/ses_1/synthetic")
    expect(paths.at(-1)).toBe("/api/session/ses_1/command")
    expect(requests.at(-2)?.body).toMatchObject({ text: "quoted selection", resume: false })
    expect(requests.at(-1)?.body).toMatchObject({ name: "review", text: "src" })
  })
})

describe("directory availability batching", () => {
  const answerPaths = (request: CapturedRequest) => {
    const paths = (request.body as { paths: string[] }).paths
    return json({
      results: paths.map((path) => path.endsWith("/gone")
        ? { path, isDirectory: false, reason: "not-found" }
        : { path, isDirectory: true }),
    })
  }
  const availabilityCalls = () =>
    requests.filter((request) => request.url.pathname === "/api/fs/directory-stats")

  test("coalesces probes admitted in one window into a single request", async () => {
    responses.push(answerPaths)
    const results = await Promise.all([
      opencodeClient.getDirectoryAvailability("/repo/one"),
      opencodeClient.getDirectoryAvailability("/repo/two"),
      opencodeClient.getDirectoryAvailability("/repo/gone"),
    ])
    expect(results).toEqual(["available", "available", "missing"])
    expect(availabilityCalls().length).toBe(1)
  })

  test("chunks more paths than the server accepts into multiple requests", async () => {
    responses.push(answerPaths, answerPaths)
    const directories = Array.from({ length: 250 }, (_, index) => `/repo/chunk-${index}`)
    const results = await Promise.all(
      directories.map((directory) => opencodeClient.getDirectoryAvailability(directory)),
    )
    expect(results.every((value) => value === "available")).toBe(true)
    const calls = availabilityCalls()
    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect((call.body as { paths: string[] }).paths.length).toBeLessThanOrEqual(200)
    }
  })

  test("reports unknown without a request when the runtime changed before flush", async () => {
    const pending = [
      opencodeClient.getDirectoryAvailability("/repo/one"),
      opencodeClient.getDirectoryAvailability("/repo/two"),
    ]
    runtimeKey = "other"
    const results = await Promise.all(pending)
    expect(results).toEqual(["unknown", "unknown"])
    expect(availabilityCalls().length).toBe(0)
  })

  test("reports unknown when the runtime refuses the probe (VS Code 501)", async () => {
    responses.push(json({ error: "Directory availability probes are not supported in the VS Code runtime" }, 501))
    const results = await Promise.all([
      opencodeClient.getDirectoryAvailability("/repo/one"),
      opencodeClient.getDirectoryAvailability("/repo/two"),
    ])
    expect(results).toEqual(["unknown", "unknown"])
  })
})

describe("an engine chat read back after a reload", () => {
  // The page the engine history route served for a turn with reasoning, text,
  // a page the user answered, more text and reasoning, a failed call and a
  // last text, recorded by packages/web/server/lib/engine/history.test.js.
  const recordedPage = readFileSync(new URL("../../../../web/server/lib/engine/test/history-page.json", import.meta.url), "utf8")
  const T0 = 1_792_000_000_000
  const promptID = "msg_13b85fff0001ClientPrompt01"
  const answerID = "msg_13b860000001ServerAnswer01"

  test("projects into the messages and parts the live stream drew", async () => {
    responses.push(new Response(recordedPage, { status: 200, headers: { "content-type": "application/json" } }))
    const page: MessagePage = await opencodeClient.getSessionMessages("ses_engine", { limit: 50 })

    expect(requests[0].url.pathname).toBe("/api/session/ses_engine/message")
    expect(page.cursor).toEqual({})
    const [answer, prompt] = page.items
    const owner = (messageID: string) => ({ sessionID: "ses_engine", messageID })

    expect(prompt.info).toEqual({ id: promptID, sessionID: "ses_engine", role: "user", time: { created: T0 } })
    expect(prompt.parts).toEqual([
      { id: partIds.userText(promptID), ...owner(promptID), type: "text", text: "Plan the storage", time: { start: T0, end: T0 } },
    ])

    expect(answer.info).toEqual({
      id: answerID,
      sessionID: "ses_engine",
      role: "assistant",
      time: { created: T0, completed: T0 + 11000 },
      agent: "fake",
      providerID: "fake-provider",
      modelID: "fast",
      finish: "stop",
      cost: 0,
      tokens: { input: 1200, output: 340, reasoning: 80, cache: { read: 4000, write: 0 }, total: 2900 },
    })
    // The ids the live events address: each run of reasoning or text streams
    // with its own ordinal, counted per type (`session.reasoning.*`,
    // `session.text.*`), and a call by its id (`session.tool.*`).
    expect(answer.parts.map((part) => part.id)).toEqual([
      partIds.reasoning(answerID, 0),
      partIds.text(answerID, 0),
      partIds.tool("toolu_page"),
      partIds.text(answerID, 1),
      partIds.reasoning(answerID, 1),
      partIds.tool("toolu_read"),
      partIds.text(answerID, 2),
    ])
    const [reasoning, text, pageCall, secondText, secondReasoning, readCall, lastText] = answer.parts
    expect(reasoning).toEqual({
      id: partIds.reasoning(answerID, 0),
      ...owner(answerID),
      type: "reasoning",
      text: "The user should pick the database.",
      time: { start: T0 + 1000, end: T0 + 2000 },
    })
    expect(secondReasoning).toEqual({
      id: partIds.reasoning(answerID, 1),
      ...owner(answerID),
      type: "reasoning",
      text: "The storage notes should say why.",
      time: { start: T0 + 7000, end: T0 + 8000 },
    })
    const textPart = (ordinal: number, value: string) => ({
      id: partIds.text(answerID, ordinal),
      ...owner(answerID),
      type: "text",
      text: value,
      time: { start: T0, end: T0 + 11000 },
    })
    expect(text).toEqual(textPart(0, "Here is the choice."))
    expect(secondText).toEqual(textPart(1, "You picked Postgres."))
    expect(lastText).toEqual(textPart(2, "There are no storage notes yet."))
    expect(readCall).toEqual({
      id: "toolu_read",
      ...owner(answerID),
      type: "tool",
      callID: "toolu_read",
      tool: "Read",
      executed: true,
      state: {
        status: "error",
        input: { file_path: "docs/storage.md" },
        error: "File does not exist.",
        output: "File does not exist.",
        time: { start: T0 + 8000, end: T0 + 9000 },
      },
    })

    // The page the user answered is drawn from the call's input and metadata.
    if (pageCall.type !== "tool" || pageCall.state.status !== "completed") throw new Error("expected the finished page call")
    expect(pageCall).toMatchObject({ callID: "toolu_page", tool: "openchamber_render", executed: true })
    expect(pageCall.state.time).toEqual({ start: T0 + 4000, end: T0 + 5000 })
    expect(pageCall.state.metadata).toMatchObject({ openchamber: { ok: true, action: "render.page" } })
    expect(renderedPage(pageCall.tool, pageCall.state)).toEqual({
      html: "<p>Postgres or SQLite?</p>",
      title: "Pick a database",
      ask: { kind: "answered", summary: "Postgres", data: { choice: "postgres" } },
    })
  })
})

describe("the context meter on an engine chat read back after a reload", () => {
  // The same recorded page. The answer's counts add up every model call of its
  // turn (5620 tokens); `total` is what the turn's last call read and wrote.
  const recordedPage = readFileSync(new URL("../../../../web/server/lib/engine/test/history-page.json", import.meta.url), "utf8")

  test("reads the context the turn ended with, not the sum of its calls", async () => {
    responses.push(new Response(recordedPage, { status: 200, headers: { "content-type": "application/json" } }))
    const page: MessagePage = await opencodeClient.getSessionMessages("ses_engine", { limit: 50 })
    const messages = [...page.items].reverse().map((message) => message.info)

    expect(buildSessionContextUsage(messages, 10_000, 1_000)).toMatchObject({ state: "measured", totalTokens: 2900, percentage: 29 })
  })
})

describe("the engine catalog read through the client", () => {
  // What the engine catalog and MCP routes answered with Claude Code installed
  // and signed in, Antigravity not installed and Codex signed out, recorded by
  // packages/web/server/lib/engine/catalog.test.js.
  const recorded = z.object({
    model: z.json(),
    modelDefault: z.json(),
    provider: z.json(),
    mcp: z.json(),
    mcpDisconnect: z.json(),
  }).parse(JSON.parse(readFileSync(new URL("../../../../web/server/lib/engine/test/catalog-responses.json", import.meta.url), "utf8")))
  const answerRecorded = (request: CapturedRequest) => {
    if (request.url.pathname === "/api/model") return json(recorded.model)
    if (request.url.pathname === "/api/model/default") return json(recorded.modelDefault)
    if (request.url.pathname === "/api/provider") return json(recorded.provider)
    if (request.url.pathname === "/api/mcp") return json(recorded.mcp)
    return json(recorded.mcpDisconnect, 400)
  }
  const directory = "/work/repo"

  test("gives the model picker every engine with its models and reasoning variants", async () => {
    responses.push(answerRecorded, answerRecorded, answerRecorded)
    const catalog: ProviderCatalog = await opencodeClient.getProvidersForConfig(directory)

    expect(requests.map((request) => request.url.pathname).sort()).toEqual(["/api/model", "/api/model/default", "/api/provider"])
    for (const request of requests) expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory))

    expect(catalog.providers.map((provider) => [provider.id, provider.name, provider.activation])).toEqual([
      ["anthropic", "Claude Code", "enabled"],
      ["google", "Antigravity", "auto"],
      ["openai", "Codex", "auto"],
    ])
    expect(catalog.default).toEqual({ id: "sonnet", providerID: "anthropic" })

    // The config store offers a provider that is not disabled and has an enabled model.
    expect(catalog.providers.every((provider) => provider.activation !== "disabled")).toBe(true)
    expect(catalog.models.every((model) => model.enabled)).toBe(true)

    const modelsOf = (providerID: string) => catalog.models.filter((model) => model.providerID === providerID)
    expect(modelsOf("anthropic").map((model) => model.id)).toEqual(["sonnet", "opus", "haiku"])
    expect(modelsOf("google").map((model) => model.id)).toEqual(["default", "gemini-3.8-flash"])
    expect(modelsOf("openai")).toHaveLength(8)

    const variantsOf = (id: string) => listModelVariantIds(catalog.models.find((model) => model.id === id)?.variants)
    expect(variantsOf("sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(variantsOf("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh"])
    expect(variantsOf("gemini-3.8-flash")).toEqual(["low", "medium", "high"])
    expect(variantsOf("default")).toEqual([])

    const sonnet = catalog.models.find((model) => model.id === "sonnet")
    expect(sonnet?.limit).toEqual({ context: 1_000_000, output: 128_000 })
    // No image input, so the composer offers no attachment for an engine model.
    expect(sonnet?.capabilities.input).toEqual(["text"])
  })

  test("lists OpenChamber's tool server and shows why it cannot be disconnected", async () => {
    responses.push(answerRecorded)
    expect(await opencodeClient.listMcpServers(directory)).toEqual([{ name: "openchamber", status: { status: "connected" } }])

    responses.push(answerRecorded)
    const failure = await opencodeClient.disconnectMcpServer("openchamber", directory).catch((error: Error) => error)
    expect(requests.at(-1)?.url.pathname).toBe("/api/experimental/mcp/openchamber/disconnect")
    expect(failure).toBeInstanceOf(OpencodeApiError)
    expect(failure).toMatchObject({
      status: 400,
      tag: "InvalidRequestError",
      detail: "OpenChamber's tools stay connected to every engine chat. Turn single tools off in Settings, under OpenChamber Tools.",
    })
  })
})

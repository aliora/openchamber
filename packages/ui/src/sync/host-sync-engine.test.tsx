import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { OpenCodeEvent } from "@opencode/client"

import { hostRegistry } from "@/lib/hosts/runtime/app-host"
import { setMultiHostRuntime } from "@/lib/hosts/runtime/multi-host-flag"
import { createRuntimeTransport } from "@/lib/hosts/runtime/runtime-transport"
import type { HostRuntime } from "@/lib/hosts/runtime/types"
import type { PermissionRequest } from "@/lib/opencode/model"
import { OpencodeService } from "@/lib/opencode/client"
import { createRelayTunnelClient } from "@/lib/relay/tunnel-client"
import { useConfigStore } from "@/stores/useConfigStore"
import { installHookTestDom } from "../components/session/sidebar/test-utils/testDom"
import type { ChildStoreManager } from "./child-store"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { HostSyncScope, SyncProvider, useChildStoreManager } from "./sync-context"

type FakeHost = {
  host: HostRuntime
  emit: (event: OpenCodeEvent) => void
  subscriptions: () => number
  sessionListRequests: () => number
}

const statusBusy = (sessionID: string): OpenCodeEvent => ({
  id: `evt_${sessionID}`,
  created: 1,
  location: { directory: "/work" },
  type: "session.status",
  data: { sessionID, status: { type: "busy" } },
})

const permission: PermissionRequest = { id: "per_bg", sessionID: "ses_pending", action: "bash", resources: ["ls"], metadata: {} }

const notFound = async (input: string | URL | Request) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), "https://fake.test").pathname
  return new Response(JSON.stringify({ path }), { status: 404, headers: { "content-type": "application/json" } })
}

const registerFakeHost = (name: string): FakeHost => {
  let sessionListRequests = 0
  const transport = createRuntimeTransport({
    bootInjection: false,
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes("/session")) sessionListRequests += 1
      return notFound(input)
    },
    createTunnel: createRelayTunnelClient,
  })
  transport.reconfigure({ apiBaseUrl: `https://${name}.example` })
  const runtimeKey = `host:${name}`
  const client = new OpencodeService({ transport, runtimeKey: () => runtimeKey })
  const pending: OpenCodeEvent[] = []
  const waiting = new Set<() => void>()
  const emit = (event: OpenCodeEvent) => {
    pending.push(event)
    for (const wake of [...waiting]) wake()
  }
  const subscribe = spyOn(client.getSdkClient().event, "subscribe").mockImplementation((options) => ({
    async *[Symbol.asyncIterator]() {
      const signal = options?.signal
      while (!signal?.aborted) {
        const next = pending.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiting.delete(wake)
            resolve()
          }
          waiting.add(wake)
          signal?.addEventListener("abort", wake, { once: true })
        })
      }
    },
  }))
  const host = hostRegistry.register({
    descriptor: { id: name, label: name, kind: "direct", displayUrl: `https://${name}.example`, runtimeKey, monitored: true },
    endpoint: { kind: "direct", apiUrl: `https://${name}.example` },
  }, async () => null, { transport, client })
  useConfigStore.forHost(host.id).setState({ settingsMessageStreamTransport: "sse" })
  return { host, emit, subscriptions: () => subscribe.mock.calls.length, sessionListRequests: () => sessionListRequests }
}

const settle = async (ms = 20) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

describe("one sync engine per host", () => {
  let dom: ReturnType<typeof installHookTestDom>
  let root: Root
  const storage = new Map<string, string>()
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const previousFetch = globalThis.fetch
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const registered: FakeHost[] = []
  let windowHost: HostRuntime

  beforeEach(() => {
    globalThis.fetch = Object.assign(notFound, { preconnect: async () => {} })
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
      },
    })
    dom = installHookTestDom()
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://app.test/") })
    root = createRoot(dom.container)
    windowHost = hostRegistry.focused()
    useConfigStore.forHost(windowHost.id).setState({ settingsMessageStreamTransport: "sse" })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    hostRegistry.focus(windowHost.id)
    for (const fake of registered.splice(0)) hostRegistry.unregister(fake.host.id)
    mock.restore()
    dom.restore()
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation)
    else Reflect.deleteProperty(globalThis, "location")
    globalThis.fetch = previousFetch
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
  })

  const twoHosts = () => {
    const pi = registerFakeHost("pi")
    const pc = registerFakeHost("pc")
    registered.push(pi, pc)
    return { pi, pc }
  }

  const render = async (children: React.ReactNode = null) => {
    await act(async () => root.render(<SyncProvider sdk={windowHost.client.getSdkClient()} directory="/work">{children}</SyncProvider>))
    await settle()
  }

  test("with the flag off only the window host has an engine, as before", async () => {
    setMultiHostRuntime(false)
    const { pi, pc } = twoHosts()
    await render()
    expect(pi.subscriptions()).toBe(0)
    expect(pc.subscriptions()).toBe(0)
  })

  test("with the flag on every host has an engine and its events stay on that host", async () => {
    setMultiHostRuntime(true)
    const { pi, pc } = twoHosts()
    await render()
    expect(pi.subscriptions()).toBe(1)
    expect(pc.subscriptions()).toBe(1)

    pi.emit(statusBusy("ses_pi"))
    pc.emit(statusBusy("ses_pc"))
    await settle(80)

    const statuses = (host: HostRuntime) => [...useGlobalSessionStatusStore.forHost(host.id).getState().statusById.keys()]
    expect(statuses(pi.host)).toEqual(["ses_pi"])
    expect(statuses(pc.host)).toEqual(["ses_pc"])
    expect(statuses(windowHost)).toEqual([])
  })

  test("a background host evicts idle directory stores but keeps one with a pending permission", async () => {
    setMultiHostRuntime(true)
    const { pi } = twoHosts()
    let manager: ChildStoreManager | undefined
    const Probe = () => {
      manager = useChildStoreManager()
      return null
    }
    await render(<HostSyncScope hostId={pi.host.id}><Probe /></HostSyncScope>)
    if (!manager) throw new Error("The background host has no directory stores")
    const stores = manager
    await act(async () => {
      stores.ensureChild("/idle", { bootstrap: false })
      stores.ensureChild("/pending", { bootstrap: false }).setState({ permission: { ses_pending: [permission] } })
    })
    const now = Date.now()
    spyOn(Date, "now").mockReturnValue(now + 11 * 60_000)
    stores.runEviction()

    expect(stores.getChild("/idle")).toBeUndefined()
    expect(stores.getChild("/pending")).toBeDefined()
  })

  test("focusing a background host again re-creates its directory store once", async () => {
    setMultiHostRuntime(true)
    const { pi } = twoHosts()
    let manager: ChildStoreManager | undefined
    const Probe = () => {
      manager = useChildStoreManager()
      return null
    }
    await render(<Probe />)
    expect(manager?.getChild("/work")).toBeDefined()

    await act(async () => hostRegistry.focus(pi.host.id))
    await settle(50)
    const focusedStores = manager
    const created = focusedStores?.getChild("/work")
    const requestsAfterFocus = pi.sessionListRequests()
    await settle(300)

    expect(focusedStores?.runtimeKey).toBe(pi.host.id)
    expect(created).toBeDefined()
    expect(focusedStores?.getChild("/work")).toBe(created)
    expect(pi.sessionListRequests() - requestsAfterFocus).toBeLessThanOrEqual(1)
  })
})

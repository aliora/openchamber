import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import type { PermissionRequest } from "@/lib/opencode/model"
import { ChildStoreManager } from "./child-store"
import { FOCUSED_HOST_SYNC_POLICY, hostSyncPolicy } from "./host-background-policy"

const permission: PermissionRequest = { id: "per_1", sessionID: "ses_pending", action: "bash", resources: ["ls"], metadata: {} }

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("host background policy", () => {
  test("the focused host keeps today's limits and runs every focused-only job", () => {
    expect(hostSyncPolicy(true, "desktop")).toBe(FOCUSED_HOST_SYNC_POLICY)
    expect(hostSyncPolicy(true, "capacitor")).toBe(FOCUSED_HOST_SYNC_POLICY)
    expect(FOCUSED_HOST_SYNC_POLICY).toMatchObject({ focused: true, watchdog: true, directoryStores: null, sessionCacheLimit: null })
  })

  test("a background host is bounded by its surface and runs no watchdog", () => {
    expect(hostSyncPolicy(false, "desktop")).toMatchObject({
      focused: false,
      watchdog: false,
      directoryStores: { max: 8, idleTtlMs: 10 * 60_000 },
      sessionCacheLimit: 2,
    })
    expect(hostSyncPolicy(false, "capacitor")).toMatchObject({
      focused: false,
      watchdog: false,
      directoryStores: { max: 2, idleTtlMs: 2 * 60_000 },
      sessionCacheLimit: 0,
    })
    expect(hostSyncPolicy(false, "desktop")).toBe(hostSyncPolicy(false, "desktop"))
  })
})

describe("directory stores of a background host", () => {
  const realNow = Date.now.bind(Date)
  const later = (ms: number) => spyOn(Date, "now").mockReturnValue(realNow() + ms)

  afterEach(() => {
    mock.restore()
  })

  const backgroundStores = () => {
    const manager = new ChildStoreManager({ runtimeKey: "host:background" })
    for (const directory of ["/idle-a", "/idle-b", "/pending", "/busy", "/pinned"]) {
      manager.ensureChild(directory, { bootstrap: false })
    }
    manager.getChild("/pending")?.setState({ permission: { ses_pending: [permission] } })
    manager.getChild("/busy")?.setState({ session_status: { ses_busy: { type: "busy" } } })
    manager.pin("/pinned")
    return manager
  }

  test("idle stores go, while pinned, busy and pending ones stay", async () => {
    const manager = backgroundStores()
    manager.setEvictionLimits(hostSyncPolicy(false, "capacitor").directoryStores)
    await flushMicrotasks()
    expect(manager.children.size).toBe(5)

    later(3 * 60_000)
    manager.runEviction()
    expect([...manager.children.keys()].sort()).toEqual(["/busy", "/pending", "/pinned"])
    manager.disposeAll()
  })

  test("the same stores stay within the focused limits", async () => {
    const manager = backgroundStores()
    manager.setEvictionLimits(FOCUSED_HOST_SYNC_POLICY.directoryStores)
    await flushMicrotasks()
    manager.runEviction()
    expect(manager.children.size).toBe(5)
    manager.disposeAll()
  })

  test("focusing the host again re-creates an evicted store once, without an eviction loop", async () => {
    const manager = backgroundStores()
    const bootstrapped: string[] = []
    manager.configure({ onBootstrap: ({ directory }) => { bootstrapped.push(directory) } })
    manager.setEvictionLimits(hostSyncPolicy(false, "capacitor").directoryStores)
    later(3 * 60_000)
    manager.runEviction()
    expect(manager.getChild("/idle-a")).toBeUndefined()

    manager.setEvictionLimits(FOCUSED_HOST_SYNC_POLICY.directoryStores)
    const recreated = manager.ensureChild("/idle-a")
    manager.pin("/idle-a")
    await flushMicrotasks()
    manager.runEviction()
    await flushMicrotasks()

    expect(manager.getChild("/idle-a")).toBe(recreated)
    expect(manager.ensureChild("/idle-a")).toBe(recreated)
    await flushMicrotasks()
    expect(bootstrapped).toEqual(["/idle-a"])
    manager.disposeAll()
  })
})

import type { Message, Part } from "@/lib/opencode/model"
import { getSessionMaterializationStatus, type MaterializedState } from "./materialization"

export type SessionSnapshot = {
  messages: Message[]
  parts: Record<string, Part[]>
}

const MAX_SNAPSHOTS = 8

const snapshots = new Map<string, SessionSnapshot>()

const keyFor = (runtimeKey: string, directory: string, sessionID: string): string =>
  JSON.stringify([runtimeKey, directory, sessionID])

export function rememberSessionSnapshot(
  runtimeKey: string,
  directory: string,
  sessionID: string,
  state: MaterializedState,
): void {
  const messages = state.message[sessionID]
  const status = getSessionMaterializationStatus(state, sessionID)
  if (!messages?.length || !status.renderable) return
  const parts: Record<string, Part[]> = {}
  for (const message of messages) {
    const messageParts = state.part[message.id]
    if (messageParts) parts[message.id] = messageParts
  }
  const key = keyFor(runtimeKey, directory, sessionID)
  snapshots.delete(key)
  snapshots.set(key, { messages, parts })
  for (const oldest of snapshots.keys()) {
    if (snapshots.size <= MAX_SNAPSHOTS) break
    snapshots.delete(oldest)
  }
}

export function takeSessionSnapshot(runtimeKey: string, directory: string, sessionID: string): SessionSnapshot | null {
  const key = keyFor(runtimeKey, directory, sessionID)
  const snapshot = snapshots.get(key) ?? null
  snapshots.delete(key)
  return snapshot
}

export function resetSessionSnapshots(): void {
  snapshots.clear()
}

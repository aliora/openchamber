import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@/lib/opencode/model"
import { rememberSessionSnapshot, resetSessionSnapshots, takeSessionSnapshot } from "./runtime-session-snapshots"

const user = (id: string, sessionID: string) => ({ id, sessionID, role: "user", time: { created: 1 } }) as Message
const assistant = (id: string, sessionID: string) => ({ id, sessionID, role: "assistant", time: { created: 2 } }) as Message
const text = (messageID: string, sessionID: string) => [{ id: `part_${messageID}`, messageID, sessionID, type: "text", text: "hi" }] as Part[]

const transcript = (sessionID: string) => ({
  message: { [sessionID]: [user("m1", sessionID), assistant("m2", sessionID)] },
  part: { m1: text("m1", sessionID), m2: text("m2", sessionID), other: text("other", "elsewhere") },
})

describe("session snapshots kept across a host switch", () => {
  beforeEach(() => resetSessionSnapshots())

  test("a session left on one host comes back once, with only its own records", () => {
    rememberSessionSnapshot("host:a", "/repo", "ses_1", transcript("ses_1"))

    expect(takeSessionSnapshot("host:b", "/repo", "ses_1")).toBeNull()
    const snapshot = takeSessionSnapshot("host:a", "/repo", "ses_1")
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["m1", "m2"])
    expect(Object.keys(snapshot?.parts ?? {})).toEqual(["m1", "m2"])
    expect(takeSessionSnapshot("host:a", "/repo", "ses_1")).toBeNull()
  })

  test("a transcript whose reply parts never loaded is not kept", () => {
    const state = transcript("ses_1")
    rememberSessionSnapshot("host:a", "/repo", "ses_1", { message: state.message, part: { m1: state.part.m1 } })
    expect(takeSessionSnapshot("host:a", "/repo", "ses_1")).toBeNull()

    rememberSessionSnapshot("host:a", "/repo", "ses_empty", { message: {}, part: {} })
    expect(takeSessionSnapshot("host:a", "/repo", "ses_empty")).toBeNull()
  })

  test("only the most recent sessions are kept", () => {
    for (let index = 0; index < 12; index += 1) {
      rememberSessionSnapshot("host:a", "/repo", `ses_${index}`, transcript(`ses_${index}`))
    }
    expect(takeSessionSnapshot("host:a", "/repo", "ses_0")).toBeNull()
    expect(takeSessionSnapshot("host:a", "/repo", "ses_11")).not.toBeNull()
  })
})

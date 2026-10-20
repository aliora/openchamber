import { describe, expect, test } from "bun:test"
import type { RuntimeFetchOptions } from "@/lib/runtime-fetch"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import {
  AttachmentUploadError,
  cancelAttachmentUpload,
  readAttachmentUpload,
  startAttachmentUpload,
  uploadAttachment,
  uploadedAttachmentUri,
  waitForAttachmentUploads,
} from "./attachment-uploads"

type Call = { input: string; init: RuntimeFetchOptions }

const jsonResponse = (status: number, body: Record<string, string | number | boolean>) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const createServer = (failChunk = false) => {
  const calls: Call[] = []
  const fetch = async (input: string, init: RuntimeFetchOptions): Promise<Response> => {
    calls.push({ input, init })
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (input === "/api/attachments") return jsonResponse(201, { id: "up-1", uri: "openchamber-attachment:up-1" })
    if (init.method === "DELETE") return new Response(null, { status: 204 })
    if (failChunk) return jsonResponse(413, { error: "The file is larger than the 500 MB allowed for this kind of attachment" })
    return jsonResponse(200, { received: 0, complete: false })
  }
  return { calls, fetch }
}

const attachment = (): AttachedFile => {
  const file = new File([new Uint8Array(5 * 1024 * 1024)], "clip.mov", { type: "video/quicktime" })
  return {
    id: `att-${Math.random().toString(36).slice(2)}`,
    file,
    dataUrl: "",
    mimeType: "video/quicktime",
    filename: "clip.mov",
    size: file.size,
    source: "local",
  }
}

describe("attachment uploads", () => {
  test("declares the file, then sends it in chunks at their offsets and reports progress", async () => {
    const server = createServer()
    const progress: number[] = []
    const file = new File([new Uint8Array(5 * 1024 * 1024)], "clip.mov", { type: "video/quicktime" })
    const uri = await uploadAttachment(
      { file, filename: "clip.mov", mimeType: "video/quicktime" },
      { fetch: server.fetch, onProgress: (sent) => progress.push(sent) },
    )

    expect(uri).toBe("openchamber-attachment:up-1")
    expect(server.calls[0].init.method).toBe("POST")
    expect(JSON.parse(String(server.calls[0].init.body))).toEqual({ name: "clip.mov", mime: "video/quicktime", size: file.size })
    const chunks = server.calls.slice(1)
    expect(chunks.map((call) => [call.input, call.init.method, call.init.query])).toEqual([
      ["/api/attachments/up-1", "PUT", { offset: "0" }],
      ["/api/attachments/up-1", "PUT", { offset: String(2 * 1024 * 1024) }],
      ["/api/attachments/up-1", "PUT", { offset: String(4 * 1024 * 1024) }],
    ])
    expect(progress).toEqual([0, 2 * 1024 * 1024, 4 * 1024 * 1024, file.size])
  })

  test("drops the server's copy when a chunk is refused and says why", async () => {
    const server = createServer(true)
    const file = new File(["abc"], "a.mov", { type: "video/quicktime" })
    await expect(uploadAttachment({ file, filename: "a.mov", mimeType: "video/quicktime" }, { fetch: server.fetch }))
      .rejects.toThrow("larger than the 500 MB")
    expect(server.calls.at(-1)).toMatchObject({ input: "/api/attachments/up-1", init: { method: "DELETE" } })
  })

  test("tracks a composer attachment until it is uploaded and hands its address to the send", async () => {
    const server = createServer()
    const video = attachment()
    startAttachmentUpload(video, server.fetch)
    expect(readAttachmentUpload(video.id)?.status).toBe("uploading")
    await waitForAttachmentUploads([video])
    expect(readAttachmentUpload(video.id)).toEqual({ status: "uploaded", uri: "openchamber-attachment:up-1" })
    expect(uploadedAttachmentUri(video.id)).toBe("openchamber-attachment:up-1")
  })

  test("refuses to send a video whose upload failed, and keeps an image with its inline copy", async () => {
    const server = createServer(true)
    const video = attachment()
    const image: AttachedFile = { ...attachment(), mimeType: "image/png", filename: "shot.png", dataUrl: "data:image/png;base64,AA==" }
    startAttachmentUpload(video, server.fetch)
    startAttachmentUpload(image, server.fetch)
    await waitForAttachmentUploads([image])
    expect(uploadedAttachmentUri(image.id)).toBeUndefined()
    let refused: AttachmentUploadError | null = null
    try {
      await waitForAttachmentUploads([video])
    } catch (error) {
      if (error instanceof AttachmentUploadError) refused = error
    }
    expect(refused?.filename).toBe("clip.mov")
  })

  test("cancels a running upload and forgets it", async () => {
    const server = createServer()
    const video = attachment()
    startAttachmentUpload(video, server.fetch)
    cancelAttachmentUpload(video.id, server.fetch)
    expect(readAttachmentUpload(video.id)).toBeUndefined()
    await waitForAttachmentUploads([video])
    expect(readAttachmentUpload(video.id)).toBeUndefined()
  })

  test("leaves attachments that are not local files alone", () => {
    const server = createServer()
    const fromServer: AttachedFile = { ...attachment(), source: "server", serverPath: "/repo/a.png" }
    startAttachmentUpload(fromServer, server.fetch)
    expect(server.calls).toHaveLength(0)
    expect(readAttachmentUpload(fromServer.id)).toBeUndefined()
  })
})

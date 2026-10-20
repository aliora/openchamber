import { describe, expect, mock, test } from "bun:test"
import {
  ACCEPTED_ATTACHMENT_EXTENSIONS,
  ATTACHMENT_ACCEPT,
  getAttachmentInputModality,
  getUnsupportedAttachmentInputs,
  isReadOnSendMentionFilename,
  MEDIA_PICKER_ACCEPT,
  prepareAttachmentFile,
} from "./attachment-files"

mock.module("heic2any", () => ({
  default: async () => new Blob(["jpeg-data"], { type: "image/jpeg" }),
}))

const prepare = (file: File) => Promise.resolve(prepareAttachmentFile(file))

describe("attachment file preparation", () => {
  test("maps normalized attachment MIME types to model input modalities", () => {
    expect(getAttachmentInputModality("text/plain;charset=utf-8")).toBe("text")
    expect(getAttachmentInputModality("image/jpeg")).toBe("image")
    expect(getAttachmentInputModality("application/pdf")).toBe("pdf")
    expect(getAttachmentInputModality("audio/mpeg")).toBe("audio")
    expect(getAttachmentInputModality("video/mp4")).toBe("video")
    expect(getAttachmentInputModality("application/octet-stream")).toBe(undefined)
  })

  test("returns only attachment inputs unsupported by the model", () => {
    const attachments = [
      { filename: "notes.txt", mimeType: "text/plain" },
      { filename: "photo.jpg", mimeType: "image/jpeg" },
      { filename: "report.pdf", mimeType: "application/pdf" },
      { filename: "unknown.bin", mimeType: "application/octet-stream" },
    ]

    expect(getUnsupportedAttachmentInputs(attachments, ["TEXT", "pdf"])).toEqual([
      { attachment: attachments[1], modality: "image" },
    ])
  })

  test("exposes the expanded code and structured-text formats to pickers", () => {
    for (const extension of [
      "diff", "patch", "ipynb", "jsonl", "ndjson", "har", "svg", "drawio", "excalidraw",
      "vue", "svelte", "php", "cs", "kt", "swift", "lua", "dart", "tf", "hcl", "proto",
      "docx", "pptx", "xlsx", "odt", "odp", "ods",
    ]) {
      expect(ACCEPTED_ATTACHMENT_EXTENSIONS.includes(extension)).toBe(true)
      expect(ATTACHMENT_ACCEPT.includes(`.${extension}`)).toBe(true)
    }
  })

  test("accepts the video formats phones and browsers record", () => {
    for (const extension of ["mp4", "mov", "webm", "m4v"]) {
      expect(ACCEPTED_ATTACHMENT_EXTENSIONS.includes(extension)).toBe(true)
      expect(ATTACHMENT_ACCEPT.includes(`.${extension}`)).toBe(true)
      expect(MEDIA_PICKER_ACCEPT.includes(`.${extension}`)).toBe(true)
    }
    for (const mime of ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]) {
      expect(ATTACHMENT_ACCEPT.split(",").includes(mime)).toBe(true)
      expect(MEDIA_PICKER_ACCEPT.split(",").includes(mime)).toBe(true)
    }
    expect(MEDIA_PICKER_ACCEPT.split(",").includes("image/*")).toBe(true)
  })

  test("attaches a video as it is, without reading it", async () => {
    const clip = new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "clip.mov", { type: "video/quicktime" })
    expect(await prepare(clip)).toEqual({ file: clip, mimeType: "video/quicktime" })

    const untyped = new File([new Uint8Array([0, 1, 2])], "IMG_0001.MP4", { type: "" })
    expect(await prepare(untyped)).toEqual({ file: untyped, mimeType: "video/mp4" })

    const m4v = new File([new Uint8Array([0])], "trip.m4v", { type: "application/octet-stream" })
    expect(await prepare(m4v)).toEqual({ file: m4v, mimeType: "video/x-m4v" })

    const audio = new File([new Uint8Array([0, 1, 2])], "voice.mp3", { type: "audio/mpeg" })
    expect(await prepare(audio)).toBeUndefined()
  })

  test("reads documents and images named by a mention on send", () => {
    for (const filename of ["reports/BUDGET.XLSX", "shot.png", "photo.JPG", "anim.gif", "pic.webp", "IMG_1.heic"]) {
      expect(isReadOnSendMentionFilename(filename)).toBe(true)
    }
    for (const filename of ["notes.txt", "icon.svg", "scan.pdf"]) {
      expect(isReadOnSendMentionFilename(filename)).toBe(false)
    }
  })

  test("renders notebooks as readable markdown without binary outputs", async () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Analysis\n", "Notes"] },
        {
          cell_type: "code",
          source: ["print('ok')"],
          outputs: [
            { text: ["ok\n"] },
            { data: { "text/plain": ["result"], "image/png": "base64-image" } },
          ],
        },
      ],
    }

    const result = await prepare(new File([JSON.stringify(notebook)], "analysis.ipynb", { type: "application/json" }))
    const text = await result?.file.text()

    expect(result?.mimeType).toBe("text/plain")
    expect(text?.includes("# Notebook: analysis.ipynb")).toBe(true)
    expect(text?.includes("```python\nprint('ok')\n```")).toBe(true)
    expect(text?.includes("ok")).toBe(true)
    expect(text?.includes("[Non-text output omitted: image/png]")).toBe(true)
    expect(text?.includes("base64-image")).toBe(false)
  })

  test("redacts credentials and omits bodies from HAR files", async () => {
    const har = {
      log: {
        entries: [{
          request: {
            url: "https://example.com/api?token=secret&query=visible",
            headers: [
              { name: "Authorization", value: "Bearer secret" },
              { name: "Accept", value: "application/json" },
            ],
            cookies: [{ name: "session", value: "cookie-secret" }],
            postData: { mimeType: "application/json", text: "{\"password\":\"secret\"}" },
          },
          response: {
            headers: [{ name: "Set-Cookie", value: "session=secret" }],
            content: { mimeType: "application/json", encoding: "base64", text: "secret response" },
          },
        }],
      },
    }

    const result = await prepare(new File([JSON.stringify(har)], "network.har", { type: "application/json" }))
    const text = await result?.file.text() ?? ""
    const sanitized = JSON.parse(text)
    const entry = sanitized.log.entries[0]

    expect(result?.mimeType).toBe("text/plain")
    expect(new URL(entry.request.url).searchParams.get("token")).toBe("[REDACTED]")
    expect(entry.request.headers[0].value).toBe("[REDACTED]")
    expect(entry.request.headers[1].value).toBe("application/json")
    expect(entry.request.cookies[0].value).toBe("[REDACTED]")
    expect(entry.request.postData.text).toBe("[OMITTED BY OPENCHAMBER]")
    expect(entry.response.headers[0].value).toBe("[REDACTED]")
    expect(entry.response.content.text).toBe("[OMITTED BY OPENCHAMBER]")
    expect(entry.response.content.encoding).toBe("[OMITTED BY OPENCHAMBER]")
    expect(text.includes("Bearer secret")).toBe(false)
    expect(text.includes("secret response")).toBe(false)
  })

  test("rejects malformed HAR files instead of leaking unsanitized content", async () => {
    const result = await prepare(new File(["not valid HAR JSON"], "network.har", { type: "text/plain" }))
    expect(result).toBe(undefined)
  })

  test("treats SVG and Draw.io files as text", async () => {
    const svg = await prepare(new File(["<svg></svg>"], "diagram.svg", { type: "image/svg+xml" }))
    const drawio = await prepare(new File(["<mxfile></mxfile>"], "diagram.drawio", { type: "application/xml" }))

    expect(svg?.mimeType).toBe("text/plain")
    expect(drawio?.mimeType).toBe("text/plain")
  })

  test("converts HEIC files to JPEG before attachment", async () => {
    const result = await prepare(new File(["heic-data"], "photo.heic", { type: "image/heic" }))

    expect(result?.mimeType).toBe("image/jpeg")
    expect(result?.file.name).toBe("photo.jpg")
    expect(result?.file.type).toBe("image/jpeg")
    expect(await result?.file.text()).toBe("jpeg-data")
  })
})

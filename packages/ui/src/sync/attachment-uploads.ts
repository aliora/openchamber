import { useEffect, useState } from "react"
import { create } from "zustand"
import { z } from "zod"
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch"
import { getRuntimeUrlResolver } from "@/lib/runtime-url"
import type { AttachedFile } from "@/stores/types/sessionTypes"

const CHUNK_BYTES = 2 * 1024 * 1024
const MAX_KEPT_PREVIEWS = 20
const ATTACHMENT_URI_PREFIX = "openchamber-attachment:"
const STORED_ATTACHMENT_PATH = /^\/api\/session\/[^/]+\/attachment\/[^/]+$/

type UploadFetch = (input: string, init: RuntimeFetchOptions) => Promise<Response>

type AttachmentUpload =
  | { status: "uploading"; sent: number; total: number }
  | { status: "uploaded"; uri: string }
  | { status: "failed"; message: string }

type UploadTarget = { file: Blob; filename: string; mimeType: string }

type UploadOptions = {
  fetch?: UploadFetch
  signal?: AbortSignal
  onProgress?: (sent: number) => void
}

export class AttachmentUploadError extends Error {
  readonly filename: string

  constructor(filename: string, message: string) {
    super(message)
    this.filename = filename
  }
}

const beginResponseSchema = z.object({ id: z.string().min(1), uri: z.string().min(1) })
const errorResponseSchema = z.object({ error: z.string() })

const responseError = async (response: Response): Promise<Error> => {
  const body = errorResponseSchema.safeParse(await response.json().catch(() => null))
  return new Error(body.success ? body.data.error : `HTTP ${response.status}`)
}

const dropServerCopy = (fetch: UploadFetch, id: string): void => {
  void fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined)
}

export const uploadAttachment = async (
  { file, filename, mimeType }: UploadTarget,
  { fetch = runtimeFetch, signal, onProgress }: UploadOptions = {},
): Promise<string> => {
  const begun = await fetch("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: filename, mime: mimeType, size: file.size }),
    signal,
  })
  if (!begun.ok) throw await responseError(begun)
  const { id, uri } = beginResponseSchema.parse(await begun.json())

  try {
    onProgress?.(0)
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const chunk = file.slice(offset, offset + CHUNK_BYTES)
      const sent = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: "PUT",
        query: { offset: String(offset) },
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        signal,
      })
      if (!sent.ok) throw await responseError(sent)
      onProgress?.(offset + chunk.size)
    }
    return uri
  } catch (error) {
    dropServerCopy(fetch, id)
    throw error
  }
}

type UploadsState = { uploads: Record<string, AttachmentUpload> }

const useUploadsStore = create<UploadsState>(() => ({ uploads: {} }))
const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
const previews = new Map<string, string>()

const setUpload = (attachmentId: string, upload: AttachmentUpload | undefined): void => {
  useUploadsStore.setState((state) => {
    const uploads = { ...state.uploads }
    if (upload) uploads[attachmentId] = upload
    else delete uploads[attachmentId]
    return { uploads }
  })
}

const keepPreview = (uri: string, previewUrl: string): void => {
  if (!previewUrl) return
  previews.set(uri, previewUrl)
  const oldest = previews.keys().next().value
  if (previews.size > MAX_KEPT_PREVIEWS && oldest !== undefined) previews.delete(oldest)
}

export const useAttachmentUpload = (attachmentId: string): AttachmentUpload | undefined => (
  useUploadsStore((state) => state.uploads[attachmentId])
)

export const readAttachmentUpload = (attachmentId: string): AttachmentUpload | undefined => (
  useUploadsStore.getState().uploads[attachmentId]
)

export const uploadedAttachmentUri = (attachmentId: string): string | undefined => {
  const upload = readAttachmentUpload(attachmentId)
  return upload?.status === "uploaded" ? upload.uri : undefined
}

export const startAttachmentUpload = (attachment: AttachedFile, fetch: UploadFetch = runtimeFetch): void => {
  if (attachment.source !== "local" || running.has(attachment.id)) return
  const controller = new AbortController()
  const total = attachment.size
  setUpload(attachment.id, { status: "uploading", sent: 0, total })
  const upload = async () => {
    try {
      const uri = await uploadAttachment(
        { file: attachment.file, filename: attachment.filename, mimeType: attachment.mimeType },
        {
          fetch,
          signal: controller.signal,
          onProgress: (sent) => {
            if (!controller.signal.aborted) setUpload(attachment.id, { status: "uploading", sent, total })
          },
        },
      )
      if (controller.signal.aborted) return
      keepPreview(uri, attachment.dataUrl)
      setUpload(attachment.id, { status: "uploaded", uri })
    } catch (error) {
      if (controller.signal.aborted) return
      setUpload(attachment.id, { status: "failed", message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (running.get(attachment.id)?.controller === controller) running.delete(attachment.id)
    }
  }
  running.set(attachment.id, { controller, done: upload() })
}

export const cancelAttachmentUpload = (attachmentId: string, fetch: UploadFetch = runtimeFetch): void => {
  const uri = uploadedAttachmentUri(attachmentId)
  running.get(attachmentId)?.controller.abort()
  running.delete(attachmentId)
  setUpload(attachmentId, undefined)
  if (uri?.startsWith(ATTACHMENT_URI_PREFIX)) dropServerCopy(fetch, uri.slice(ATTACHMENT_URI_PREFIX.length))
}

export const waitForAttachmentUploads = async (attachments: readonly AttachedFile[]): Promise<void> => {
  await Promise.all(attachments.map((attachment) => running.get(attachment.id)?.done))
  for (const attachment of attachments) {
    const upload = readAttachmentUpload(attachment.id)
    if (upload?.status === "failed" && !attachment.dataUrl) {
      throw new AttachmentUploadError(attachment.filename, upload.message)
    }
  }
}

export const resolveMessageFileUrl = (url: string, urlToken = ""): string => {
  if (url.startsWith(ATTACHMENT_URI_PREFIX)) return previews.get(url) ?? ""
  if (!STORED_ATTACHMENT_PATH.test(url)) return url
  const resolver = getRuntimeUrlResolver()
  return urlToken ? resolver.assetWithUrlToken(url, urlToken) : resolver.authenticatedAsset(url)
}

export const useMessageFileUrlToken = (urls: readonly string[]): string => {
  const needsToken = urls.some((url) => STORED_ATTACHMENT_PATH.test(url))
  const [urlToken, setUrlToken] = useState("")
  useEffect(() => {
    if (!needsToken) return undefined
    let live = true
    const release = acquireRuntimeUrlAuthToken()
    void refreshRuntimeUrlAuthToken()
      .then((token) => {
        if (live) setUrlToken(token)
      })
      .catch(() => undefined)
    return () => {
      live = false
      release()
    }
  }, [needsToken])
  return urlToken
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS_MB = { image: 20, video: 500, file: 50 };
const LIMIT_ENV = {
  image: 'OPENCHAMBER_ATTACHMENT_MAX_IMAGE_MB',
  video: 'OPENCHAMBER_ATTACHMENT_MAX_VIDEO_MB',
  file: 'OPENCHAMBER_ATTACHMENT_MAX_FILE_MB',
};
const MAX_CHUNK_BYTES = 8 * MB;
const ATTACHMENT_URI_PREFIX = 'openchamber-attachment:';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const DATA_URL_PATTERN = /^data:([^;,]+)((?:;[^;,]*)*),/;
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

export class AttachmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const readAttachmentLimits = (env) => Object.fromEntries(Object.entries(DEFAULT_LIMITS_MB).map(([kind, fallback]) => {
  const configured = Number(env[LIMIT_ENV[kind]]);
  return [kind, (Number.isFinite(configured) && configured > 0 ? configured : fallback) * MB];
}));

const attachmentKind = (mime) => {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
};

const safeFileName = (name) => {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-120);
  return base || 'attachment';
};

const normalizeMime = (mime) => String(mime ?? '').split(';', 1)[0].trim().toLowerCase();

const mimeOfName = (name) => MIME_BY_EXTENSION[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const readBody = async (stream, limit) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new AttachmentError(413, 'The chunk is larger than the upload allows');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
};

export const createAttachmentStore = ({ root, limits = readAttachmentLimits(process.env), now = Date.now }) => {
  const uploadsDir = path.join(root, 'uploads');
  const sessionsDir = path.join(root, 'sessions');
  const busy = new Set();

  const limitFor = (mime) => limits[attachmentKind(mime)];
  const uploadDir = (id) => path.join(uploadsDir, id);
  const sessionDir = (sessionId) => path.join(sessionsDir, sessionId);

  const checkSize = (mime, size) => {
    if (size > limitFor(mime)) {
      throw new AttachmentError(413, `The file is larger than the ${Math.round(limitFor(mime) / MB)} MB allowed for this kind of attachment`);
    }
  };

  const requireSessionId = (sessionId) => {
    if (!SESSION_ID_PATTERN.test(String(sessionId))) throw new AttachmentError(400, 'Invalid session id');
    return sessionId;
  };

  const sweepStaleUploads = () => {
    let entries = [];
    try {
      entries = fs.readdirSync(uploadsDir);
    } catch {
      return;
    }
    for (const id of entries) {
      const meta = readJson(path.join(uploadDir(id), 'meta.json'));
      if (!meta || now() - meta.createdAt > DAY_MS) fs.rmSync(uploadDir(id), { recursive: true, force: true });
    }
  };

  const readUpload = (id) => {
    if (!ID_PATTERN.test(String(id))) return null;
    const meta = readJson(path.join(uploadDir(id), 'meta.json'));
    if (!meta) return null;
    const dataPath = path.join(uploadDir(id), 'data');
    return { meta, dataPath, received: fs.statSync(dataPath).size };
  };

  const describeStored = (sessionId, id, meta) => ({
    id,
    path: path.join(sessionDir(sessionId), id, meta.fileName),
    uri: `/api/session/${sessionId}/attachment/${id}`,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
  });

  const resolveStored = (sessionId, id) => {
    if (!SESSION_ID_PATTERN.test(String(sessionId)) || !ID_PATTERN.test(String(id))) return null;
    const meta = readJson(path.join(sessionDir(sessionId), id, 'meta.json'));
    return meta ? describeStored(sessionId, id, meta) : null;
  };

  const store = (sessionId, { name, mime, size }, place) => {
    const id = crypto.randomUUID();
    const fileName = safeFileName(name);
    const dir = path.join(sessionDir(sessionId), id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    place(path.join(dir, fileName));
    const meta = { name, mime, size, fileName, createdAt: now() };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return describeStored(sessionId, id, meta);
  };

  const claimUpload = (sessionId, id) => {
    if (!ID_PATTERN.test(id)) throw new AttachmentError(400, 'Unknown attachment');
    const stored = resolveStored(sessionId, id);
    if (stored) return stored;
    const upload = readUpload(id);
    if (!upload || upload.received !== upload.meta.size || busy.has(id)) {
      throw new AttachmentError(400, 'The attachment is not uploaded');
    }
    const dir = path.join(sessionDir(sessionId), id);
    const fileName = safeFileName(upload.meta.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.linkSync(upload.dataPath, path.join(dir, fileName));
    const meta = { ...upload.meta, fileName };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return describeStored(sessionId, id, meta);
  };

  const claimDataUrl = (sessionId, uri, name) => {
    const match = DATA_URL_PATTERN.exec(uri);
    if (!match) throw new AttachmentError(400, 'Invalid data URL');
    const mime = normalizeMime(match[1]);
    const payload = uri.slice(match[0].length);
    const data = match[2].split(';').includes('base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
    checkSize(mime, data.length);
    return store(sessionId, { name: name || `attachment.${mime.split('/')[1]}`, mime, size: data.length }, (target) => {
      fs.writeFileSync(target, data, { mode: 0o600 });
    });
  };

  const referenceHostFile = (uri, name) => {
    let filePath;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      throw new AttachmentError(400, 'Invalid file URL');
    }
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new AttachmentError(400, 'The attached file does not exist on the server');
    const fileName = name || path.basename(filePath);
    return { id: null, path: filePath, uri, name: fileName, mime: mimeOfName(fileName), size: stat.size };
  };

  const claimOne = (sessionId, { uri, name }) => {
    const value = String(uri ?? '');
    if (value.startsWith(ATTACHMENT_URI_PREFIX)) return claimUpload(sessionId, value.slice(ATTACHMENT_URI_PREFIX.length));
    if (value.startsWith('data:')) return claimDataUrl(sessionId, value, name);
    if (value.startsWith('file:')) return referenceHostFile(value, name);
    throw new AttachmentError(400, 'Unsupported attachment address');
  };

  return {
    begin({ name, mime, size }) {
      const normalizedMime = normalizeMime(mime);
      if (!name || String(name).length > 255) throw new AttachmentError(400, 'Invalid file name');
      if (!MIME_PATTERN.test(normalizedMime)) throw new AttachmentError(400, 'Invalid file type');
      if (!Number.isSafeInteger(size) || size < 0) throw new AttachmentError(400, 'Invalid file size');
      checkSize(normalizedMime, size);
      sweepStaleUploads();
      const id = crypto.randomUUID();
      fs.mkdirSync(uploadDir(id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(uploadDir(id), 'data'), '', { mode: 0o600 });
      fs.writeFileSync(path.join(uploadDir(id), 'meta.json'), JSON.stringify({ name, mime: normalizedMime, size, createdAt: now() }));
      return { id, uri: `${ATTACHMENT_URI_PREFIX}${id}` };
    },

    async append(id, offset, body) {
      const upload = readUpload(id);
      if (!upload) throw new AttachmentError(404, 'Unknown upload');
      if (busy.has(id) || offset !== upload.received) {
        throw new AttachmentError(409, `The upload continues at byte ${upload.received}`);
      }
      busy.add(id);
      try {
        const chunk = await readBody(body, Math.min(MAX_CHUNK_BYTES, upload.meta.size - upload.received));
        fs.appendFileSync(upload.dataPath, chunk);
        const received = upload.received + chunk.length;
        return { received, complete: received === upload.meta.size };
      } finally {
        busy.delete(id);
      }
    },

    cancel(id) {
      if (ID_PATTERN.test(String(id))) fs.rmSync(uploadDir(id), { recursive: true, force: true });
    },

    async claim(sessionId, files) {
      requireSessionId(sessionId);
      return files.map((file) => claimOne(sessionId, file));
    },

    resolveStored,

    removeSession(sessionId) {
      if (SESSION_ID_PATTERN.test(String(sessionId))) fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
    },
  };
};

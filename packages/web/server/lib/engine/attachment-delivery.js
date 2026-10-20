import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const NATIVE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const SIPS_TIMEOUT_MS = 30_000;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

const convertHeicWithSips = (source) => {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const target = path.join(path.dirname(source), `${path.parse(source).name}.jpg`);
  if (fs.existsSync(target)) return Promise.resolve(target);
  return new Promise((resolve) => {
    execFile('sips', ['-s', 'format', 'jpeg', source, '--out', target], { timeout: SIPS_TIMEOUT_MS }, (error) => {
      resolve(error ? null : target);
    });
  });
};

const prepareOne = async (attachment, convertHeic) => {
  if (NATIVE_IMAGE_MIMES.has(attachment.mime)) return { ...attachment, kind: 'image' };
  if (!HEIC_MIMES.has(attachment.mime) || !attachment.id) return { ...attachment, kind: 'file' };
  const converted = await convertHeic(attachment.path);
  return converted
    ? { ...attachment, kind: 'image', path: converted, mime: 'image/jpeg', size: fs.statSync(converted).size }
    : { ...attachment, kind: 'file' };
};

export const prepareAttachmentsForEngine = (attachments, { convertHeic = convertHeicWithSips } = {}) => (
  Promise.all(attachments.map((attachment) => prepareOne(attachment, convertHeic)))
);

const formatSize = (bytes) => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
};

export const appendAttachmentPaths = (text, attachments, asPath) => {
  const lines = attachments.filter(asPath).map((item) => `Attachment: ${item.path} (${item.mime}, ${formatSize(item.size)})`);
  if (lines.length === 0) return text;
  return [text, lines.join('\n')].filter(Boolean).join('\n\n');
};

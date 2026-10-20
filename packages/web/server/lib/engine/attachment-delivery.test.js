import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAttachmentPaths, prepareAttachmentsForEngine } from './attachment-delivery.js';

const MB = 1024 * 1024;

describe('attachment delivery', () => {
  it('marks the image types every engine reads as images and everything else as files', async () => {
    const prepared = await prepareAttachmentsForEngine([
      { path: '/d/a.png', name: 'a.png', mime: 'image/png', size: 10 },
      { path: '/d/b.mov', name: 'b.mov', mime: 'video/quicktime', size: 42 * MB },
      { path: '/d/c.pdf', name: 'c.pdf', mime: 'application/pdf', size: 2048 },
      { path: '/d/d.svg', name: 'd.svg', mime: 'image/svg+xml', size: 300 },
    ], { convertHeic: async () => null });
    expect(prepared.map((item) => item.kind)).toEqual(['image', 'file', 'file', 'file']);
  });

  it('turns a HEIC photo into a JPEG image when it can, and into a file when it cannot', async () => {
    const heic = { id: 'a1', path: '/d/IMG_1.HEIC', name: 'IMG_1.HEIC', mime: 'image/heic', size: 10 };
    const jpeg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-delivery-test-')), 'IMG_1.jpg');
    fs.writeFileSync(jpeg, 'jpeg');
    const [converted] = await prepareAttachmentsForEngine([heic], { convertHeic: async () => jpeg });
    expect(converted).toMatchObject({ kind: 'image', path: jpeg, mime: 'image/jpeg', size: 4 });
    fs.rmSync(path.dirname(jpeg), { recursive: true, force: true });
    const [kept] = await prepareAttachmentsForEngine([heic], { convertHeic: async () => null });
    expect(kept).toMatchObject({ kind: 'file', path: '/d/IMG_1.HEIC', mime: 'image/heic' });
    const [hostFile] = await prepareAttachmentsForEngine([{ ...heic, id: null }], { convertHeic: async (source) => `${source}.jpg` });
    expect(hostFile).toMatchObject({ kind: 'file', path: '/d/IMG_1.HEIC' });
  });

  it('appends one line per file with its host path, type and size', () => {
    const text = appendAttachmentPaths('Look at this', [
      { kind: 'image', path: '/d/a.png', mime: 'image/png', size: 10 },
      { kind: 'file', path: '/d/clip.mp4', mime: 'video/mp4', size: 42 * MB },
      { kind: 'file', path: '/d/notes.txt', mime: 'text/plain', size: 1536 },
    ], (item) => item.kind === 'file');
    expect(text).toBe('Look at this\n\nAttachment: /d/clip.mp4 (video/mp4, 42 MB)\nAttachment: /d/notes.txt (text/plain, 1.5 KB)');
  });

  it('leaves the text alone when nothing goes as a path', () => {
    expect(appendAttachmentPaths('hi', [{ kind: 'image', path: '/d/a.png', mime: 'image/png', size: 1 }], (item) => item.kind === 'file')).toBe('hi');
    expect(appendAttachmentPaths('', [{ kind: 'file', path: '/d/a.mov', mime: 'video/quicktime', size: 1 }], () => true)).toBe('Attachment: /d/a.mov (video/quicktime, 1 B)');
  });
});

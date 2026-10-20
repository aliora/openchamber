import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { AttachmentError, createAttachmentStore, readAttachmentLimits } from './attachments.js';

const MB = 1024 * 1024;

const bodyOf = (text) => Readable.from([Buffer.from(text)]);

describe('attachment store', () => {
  let root;
  let attachments;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attachments-test-'));
    attachments = createAttachmentStore({ root, limits: { image: 10, video: 20, file: 15 } });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const upload = async ({ name = 'shot.png', mime = 'image/png', content = 'png-bytes' } = {}) => {
    const { id, uri } = attachments.begin({ name, mime, size: Buffer.byteLength(content) });
    const result = await attachments.append(id, 0, bodyOf(content));
    return { id, uri, result };
  };

  it('stores a chunked upload and links it into the session folder when a prompt claims it', async () => {
    const { id, uri } = attachments.begin({ name: 'clip.mp4', mime: 'video/mp4', size: 6 });
    expect(uri).toBe(`openchamber-attachment:${id}`);
    expect(await attachments.append(id, 0, bodyOf('abc'))).toEqual({ received: 3, complete: false });
    expect(await attachments.append(id, 3, bodyOf('def'))).toEqual({ received: 6, complete: true });

    const [claimed] = await attachments.claim('ses_1', [{ uri, name: 'clip.mp4' }]);
    expect(claimed).toMatchObject({ id, name: 'clip.mp4', mime: 'video/mp4', size: 6 });
    expect(claimed.path.startsWith(path.join(root, 'sessions', 'ses_1'))).toBe(true);
    expect(fs.readFileSync(claimed.path, 'utf8')).toBe('abcdef');
    expect(claimed.uri).toBe(`/api/session/ses_1/attachment/${id}`);
  });

  it('lets several sessions claim one upload, each into its own folder', async () => {
    const { uri } = await upload();
    const [first] = await attachments.claim('ses_1', [{ uri }]);
    const [second] = await attachments.claim('ses_2', [{ uri }]);
    expect(path.dirname(path.dirname(second.path))).toBe(path.join(root, 'sessions', 'ses_2'));
    attachments.removeSession('ses_1');
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.readFileSync(second.path, 'utf8')).toBe('png-bytes');
  });

  it('claims the same upload again from the session folder', async () => {
    const { uri } = await upload();
    const [first] = await attachments.claim('ses_1', [{ uri }]);
    const [again] = await attachments.claim('ses_1', [{ uri }]);
    expect(again.path).toBe(first.path);
  });

  it('refuses a file over the limit of its kind before anything is written', () => {
    expect(() => attachments.begin({ name: 'big.png', mime: 'image/png', size: 11 })).toThrow(AttachmentError);
    expect(() => attachments.begin({ name: 'big.mov', mime: 'video/quicktime', size: 21 })).toThrow(AttachmentError);
    expect(() => attachments.begin({ name: 'big.pdf', mime: 'application/pdf', size: 16 })).toThrow(AttachmentError);
    expect(attachments.begin({ name: 'ok.mov', mime: 'video/quicktime', size: 20 }).id).toBeTruthy();
    try {
      attachments.begin({ name: 'big.png', mime: 'image/png', size: 11 });
    } catch (error) {
      expect(error.status).toBe(413);
    }
  });

  it('refuses bytes past the declared size and keeps nothing of them', async () => {
    const { id } = attachments.begin({ name: 'a.txt', mime: 'text/plain', size: 3 });
    await expect(attachments.append(id, 0, bodyOf('abcd'))).rejects.toMatchObject({ status: 413 });
    await expect(attachments.append(id, 0, bodyOf('abc'))).resolves.toEqual({ received: 3, complete: true });
  });

  it('refuses a chunk that does not continue where the upload stands', async () => {
    const { id } = attachments.begin({ name: 'a.txt', mime: 'text/plain', size: 6 });
    await attachments.append(id, 0, bodyOf('abc'));
    await expect(attachments.append(id, 1, bodyOf('xyz'))).rejects.toMatchObject({ status: 409 });
  });

  it('names stored files itself, so a name cannot leave the session folder', async () => {
    const { uri } = await upload({ name: '../../../etc/passwd', mime: 'text/plain', content: 'x' });
    const [claimed] = await attachments.claim('ses_1', [{ uri }]);
    expect(path.dirname(path.dirname(claimed.path))).toBe(path.join(root, 'sessions', 'ses_1'));
    expect(path.basename(claimed.path)).toBe('passwd');
    expect(() => attachments.begin({ name: '..', mime: 'text/plain', size: 1 })).not.toThrow();
  });

  it('refuses ids and session ids that are not its own', async () => {
    await expect(attachments.append('../../x', 0, bodyOf('a'))).rejects.toMatchObject({ status: 404 });
    await expect(attachments.claim('ses_1', [{ uri: 'openchamber-attachment:../../x' }])).rejects.toMatchObject({ status: 400 });
    await expect(attachments.claim('../ses', [{ uri: 'data:text/plain;base64,YQ==' }])).rejects.toMatchObject({ status: 400 });
    expect(attachments.resolveStored('ses_1', '../../sessions.json')).toBeNull();
  });

  it('refuses an upload that is not complete', async () => {
    const { id, uri } = attachments.begin({ name: 'a.txt', mime: 'text/plain', size: 6 });
    await attachments.append(id, 0, bodyOf('abc'));
    await expect(attachments.claim('ses_1', [{ uri }])).rejects.toMatchObject({ status: 400 });
  });

  it('stores a data URL with the limit of its kind', async () => {
    const [claimed] = await attachments.claim('ses_1', [{ uri: `data:image/png;base64,${Buffer.from('hi').toString('base64')}`, name: 'p.png' }]);
    expect(claimed).toMatchObject({ name: 'p.png', mime: 'image/png', size: 2 });
    expect(fs.readFileSync(claimed.path, 'utf8')).toBe('hi');
    const tooBig = `data:image/png;base64,${Buffer.alloc(11).toString('base64')}`;
    await expect(attachments.claim('ses_1', [{ uri: tooBig }])).rejects.toMatchObject({ status: 413 });
  });

  it('passes a host file reference through by its path', async () => {
    const hostFile = path.join(root, 'notes.md');
    fs.writeFileSync(hostFile, '# notes');
    const [claimed] = await attachments.claim('ses_1', [{ uri: `file://${hostFile}`, name: 'notes.md' }]);
    expect(claimed).toMatchObject({ path: hostFile, uri: `file://${hostFile}`, size: 7 });
    await expect(attachments.claim('ses_1', [{ uri: `file://${path.join(root, 'missing')}` }])).rejects.toMatchObject({ status: 400 });
  });

  it('cancels an upload and removes a session folder', async () => {
    const { id, uri } = await upload();
    attachments.cancel(id);
    expect(fs.existsSync(path.join(root, 'uploads', id))).toBe(false);

    const second = await upload();
    await attachments.claim('ses_1', [{ uri: second.uri }]);
    attachments.removeSession('ses_1');
    expect(fs.existsSync(path.join(root, 'sessions', 'ses_1'))).toBe(false);
    await expect(attachments.claim('ses_1', [{ uri }])).rejects.toMatchObject({ status: 400 });
  });

  it('drops uploads nobody claimed within a day', () => {
    let now = 1_000;
    attachments = createAttachmentStore({ root, now: () => now });
    const { id } = attachments.begin({ name: 'a.txt', mime: 'text/plain', size: 1 });
    now += 25 * 60 * 60 * 1000;
    attachments.begin({ name: 'b.txt', mime: 'text/plain', size: 1 });
    expect(fs.existsSync(path.join(root, 'uploads', id))).toBe(false);
  });

  it('reads its limits from the environment in megabytes', () => {
    expect(readAttachmentLimits({})).toEqual({ image: 20 * MB, video: 500 * MB, file: 50 * MB });
    expect(readAttachmentLimits({ OPENCHAMBER_ATTACHMENT_MAX_VIDEO_MB: '1000', OPENCHAMBER_ATTACHMENT_MAX_IMAGE_MB: 'x' }))
      .toEqual({ image: 20 * MB, video: 1000 * MB, file: 50 * MB });
  });
});

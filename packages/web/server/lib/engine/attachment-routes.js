import { z } from 'zod';
import { AttachmentError } from './attachments.js';

const beginSchema = z.object({
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});

const offsetSchema = z.coerce.number().int().nonnegative();

const sendError = (res, error) => {
  if (error instanceof AttachmentError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: error.message });
};

export const registerAttachmentRoutes = (app, { attachments }) => {
  app.post('/api/attachments', (req, res) => {
    const body = beginSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'name, mime and size are required' });
    try {
      res.status(201).json(attachments.begin(body.data));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/attachments/:id', async (req, res) => {
    const offset = offsetSchema.safeParse(req.query.offset ?? 0);
    if (!offset.success) return res.status(400).json({ error: 'offset must be a byte count' });
    try {
      res.json(await attachments.append(req.params.id, offset.data, req));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/attachments/:id', (req, res) => {
    attachments.cancel(req.params.id);
    res.status(204).end();
  });

  app.get('/api/session/:id/attachment/:attachmentId', (req, res) => {
    const stored = attachments.resolveStored(req.params.id, req.params.attachmentId);
    if (!stored) return res.status(404).json({ error: 'Attachment not found' });
    res.type(stored.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(stored.path, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Attachment not found' });
    });
  });
};

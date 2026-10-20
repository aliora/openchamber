import { z } from 'zod';

import { PORTABLE_CATEGORIES, isValidPortableKey } from './catalog.js';

const MAX_ENTRIES = 500;

const refSchema = z.object({
  category: z.enum(PORTABLE_CATEGORIES),
  key: z.string().refine(isValidPortableKey),
});

const updatedAtSchema = z.number().finite().nonnegative().nullish().transform((value) => value ?? null);

const exportSchema = z.object({ items: z.array(refSchema).min(1).max(MAX_ENTRIES) });

const importSchema = z.object({
  items: z.array(refSchema.extend({ value: z.json(), updatedAt: updatedAtSchema })).max(MAX_ENTRIES).default([]),
  removals: z.array(refSchema.extend({ updatedAt: updatedAtSchema })).max(MAX_ENTRIES).default([]),
  force: z.boolean().default(false),
});

export const registerPortableSettingsRoutes = (app, { getCatalog }) => {
  app.get('/api/portable-settings', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await (await getCatalog()).snapshot());
    } catch (error) {
      console.error('[portable-settings] Snapshot failed:', error?.message ?? error);
      res.status(500).json({ error: 'Could not read the shared settings' });
    }
  });

  app.post('/api/portable-settings/export', async (req, res) => {
    const request = exportSchema.safeParse(req.body);
    if (!request.success) {
      return res.status(400).json({ error: 'items must list 1 to 500 { category, key } entries' });
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ items: await (await getCatalog()).exportItems(request.data.items) });
    } catch (error) {
      console.error('[portable-settings] Export failed:', error?.message ?? error);
      res.status(500).json({ error: 'Could not read the shared settings' });
    }
  });

  app.put('/api/portable-settings', async (req, res) => {
    const request = importSchema.safeParse(req.body);
    if (!request.success) {
      return res.status(400).json({ error: 'Expected { items?, removals?, force? } with at most 500 entries each' });
    }
    try {
      res.json({ results: await (await getCatalog()).importItems(request.data) });
    } catch (error) {
      console.error('[portable-settings] Import failed:', error?.message ?? error);
      res.status(500).json({ error: 'Could not write the shared settings' });
    }
  });
};

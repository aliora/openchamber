import { publicEnterprisePolicy } from '../enterprise-mode.js';

export const registerOpenChamberRoutes = (app, dependencies) => {
  const {
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
    fetchFreeZenModels,
    getCachedZenModels,
  } = dependencies;

  // Whether an administrator turned on enterprise mode, and by which source.
  // Pinned endpoints and keys never leave the server.
  app.get('/api/openchamber/enterprise-policy', (_req, res) => {
    res.json(publicEnterprisePolicy());
  });

  app.get('/api/openchamber/update-check', (_req, res) => {
    res.json({ available: false });
  });

  app.get('/api/openchamber/models-metadata', async (_req, res) => {
    try {
      const { getModelsMetadata, toClientModelsMetadata } = await import('./models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(toClientModelsMetadata(metadata));
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502;
      res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
    }
  });

  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      const cachedZenModels = getCachedZenModels();
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};

import { EngineAccounts } from '../engine/accounts.js';

export function registerQuotaRoutes(app, { getQuotaProviders, accounts = new EngineAccounts() }) {
  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      res.json({ providers: await listConfiguredQuotaProviders() });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
      const account = providerId === 'claude' || providerId === 'codex'
        ? accounts.resolve(providerId, req.query.accountId)
        : { id: 'default' };
      if (account.id !== 'default') {
        return res.json({
          providerId, providerName: providerId === 'claude' ? 'Claude' : 'Codex',
          accountId: account.id, ok: false, configured: false, usage: null,
          error: 'Quota is unavailable for named accounts. Usage tracking currently reads the default CLI sign-in.',
          fetchedAt: Date.now(),
        });
      }
      const { fetchQuotaForProvider } = await getQuotaProviders();
      res.json({ ...await fetchQuotaForProvider(providerId), accountId: account.id });
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}

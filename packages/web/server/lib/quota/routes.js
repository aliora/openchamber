import { EngineAccounts } from '../engine/accounts.js';

const SCOPED_PROVIDERS = ['claude', 'codex'];

const resolveProviderScope = (accounts, providerId, requestedAccountId) => {
  if (!SCOPED_PROVIDERS.includes(providerId)) return { accountId: 'default', configDir: undefined };
  const account = accounts.resolve(providerId, requestedAccountId);
  return {
    accountId: account.id,
    configDir: account.id === 'default' ? undefined : accounts.home(providerId, account.id),
  };
};

export function registerQuotaRoutes(app, { getQuotaProviders, accounts = new EngineAccounts() }) {
  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const optionsByProvider = {};
      for (const providerId of SCOPED_PROVIDERS) {
        const scope = resolveProviderScope(accounts, providerId);
        if (scope.configDir) optionsByProvider[providerId] = scope;
      }
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      res.json({ providers: await listConfiguredQuotaProviders(optionsByProvider) });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
      const scope = resolveProviderScope(accounts, providerId, req.query.accountId);
      const { fetchQuotaForProvider } = await getQuotaProviders();
      const result = scope.accountId === 'default'
        ? await fetchQuotaForProvider(providerId)
        : await fetchQuotaForProvider(providerId, scope);
      res.json({ ...result, accountId: scope.accountId });
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}

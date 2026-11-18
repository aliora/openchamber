import { AccountError } from './accounts.js';

export const registerAccountRoutes = (app, { registry, accounts, runtime, loginSessions, startLogin, runAuthAction, accountChanged }) => {
  const scoped = (adapter, id) => accounts.adapter(adapter, id);
  const route = (handler) => async (req, res) => {
    const adapter = registry.get(req.params.engine);
    if (!adapter) return res.status(404).json({ error: 'Unknown engine' });
    try { return await handler(adapter, req, res); }
    catch (error) { return res.status(error instanceof AccountError ? error.status : 500).json({ error: error.message }); }
  };
  const base = '/api/engines/:engine/accounts';
  app.get(base, route((adapter, req, res) => res.json(accounts.list(adapter.id))));
  app.post(base, route((adapter, req, res) => res.status(201).json({ data: accounts.create(adapter.id, req.body?.label) })));
  app.post(`${base}/:accountId/default`, route((adapter, req, res) => {
    const account = accounts.setDefault(adapter.id, req.params.accountId);
    accountChanged(adapter.id);
    return res.json({ data: account });
  }));
  app.delete(`${base}/:accountId`, route(async (adapter, req, res) => {
    const id = req.params.accountId;
    if (id === 'default') throw new AccountError('The ambient default account cannot be deleted', 409);
    const busy = () => accounts.isInUse(adapter.id, id) || runtime.isAccountBusy(adapter.id, id);
    if (busy()) throw new AccountError('This account is still in use. Wait for its turns to finish.', 409);
    accounts.resumeRemoval(adapter.id, id);
    const profile = accounts.adapter(adapter, id, true);
    const context = { env: accounts.environment(adapter.id, id, process.env, true), isolated: true };
    accounts.setRemoving(adapter.id, id, true);
    try {
      await runtime.retireAccount(adapter.id, id);
      await loginSessions.cancel(profile);
      await adapter.auth.logout(context);
      if (busy()) throw new AccountError('This account is still in use.', 409);
      accounts.remove(adapter.id, id);
      accountChanged(adapter.id);
    } catch (error) {
      // A completed remove may report retired-file cleanup failure. Restore only
      // a profile whose metadata still exists, preserving the partial result.
      if (accounts.read().accounts.some((entry) => entry.id === id)) accounts.setRemoving(adapter.id, id, false);
      throw error;
    }
    return res.status(204).end();
  }));
  app.get(`${base}/:accountId/auth/status`, route(async (adapter, req, res) => res.json(await scoped(adapter, req.params.accountId).auth.status())));
  app.post(`${base}/:accountId/auth/login`, route((adapter, req, res) => startLogin(scoped(adapter, req.params.accountId), res)));
  app.get(`${base}/:accountId/auth/login`, route((adapter, req, res) => res.json(loginSessions.get(scoped(adapter, req.params.accountId)))));
  app.delete(`${base}/:accountId/auth/login`, route(async (adapter, req, res) => res.json(await loginSessions.cancel(scoped(adapter, req.params.accountId)))));
  app.post(`${base}/:accountId/auth/login/input`, route((adapter, req, res) => {
    const parsed = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!parsed || parsed.length > 16_384) throw new AccountError('Send the code as non-empty text');
    const session = loginSessions.input(scoped(adapter, req.params.accountId), parsed);
    if (!session) throw new AccountError('No sign-in is running for this account', 409);
    return res.json(session);
  }));
  app.post(`${base}/:accountId/auth/logout`, route((adapter, req, res) => runAuthAction(res, () => scoped(adapter, req.params.accountId).auth.logout(), 'Logged out').finally(() => accountChanged(adapter.id))));
};

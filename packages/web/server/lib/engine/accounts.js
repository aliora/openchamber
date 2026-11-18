import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveEngineDataDir } from './data-dir.js';
import { createModelCatalog, modelCatalogMethods, installedCliIdentity } from './model-catalog.js';
import { CLAUDE_FALLBACK_CATALOG } from './claude/model-catalog.js';
import { CODEX_FALLBACK_CATALOG } from './codex/model-catalog.js';

const profileId = z.string().uuid();
const labelSchema = z.string().trim().min(1).max(80);
const accountSchema = z.object({ id: profileId, label: labelSchema, engine: z.enum(['claude', 'codex']), removing: z.boolean().optional() }).strict();
const registrySchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema), defaults: z.record(z.string(), z.string()) }).strict();
const supported = (engine) => engine === 'claude' || engine === 'codex';

export class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Metadata contains no credentials. Each CLI owns the credentials in its home.
export class EngineAccounts {
  constructor({ root = resolveEngineDataDir() } = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'engine-accounts.json');
    this.adapters = new Map();
    this.uses = new Map();
    this.catalogListeners = new Set();
  }

  subscribeCatalogChange(listener) {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  async use(adapter, operation) {
    const account = this.resolve(adapter.id, adapter.accountId ?? 'default');
    const key = `${adapter.id}:${account.id}`;
    this.uses.set(key, (this.uses.get(key) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = this.uses.get(key) - 1;
      if (remaining) this.uses.set(key, remaining);
      else this.uses.delete(key);
    }
  }

  isInUse(engine, id) { return this.uses.has(`${engine}:${id}`); }

  read() {
    try { return registrySchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, accounts: [], defaults: {} };
      throw new AccountError('Engine account registry cannot be read. Restore it before using named accounts.', 503);
    }
  }

  save(data) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  home(engine, id) {
    if (!supported(engine) || !profileId.safeParse(id).success) throw new AccountError('Invalid engine account');
    return path.join(this.root, 'accounts', engine, id);
  }

  resolve(engine, id, data, allowRemoving = false) {
    if (id === 'default') return { id: 'default', label: 'Default' };
    data ??= this.read();
    const selected = id === undefined ? (data.defaults[engine] ?? 'default') : id;
    if (selected === 'default') return { id: 'default', label: 'Default' };
    const account = data.accounts.find((entry) => entry.engine === engine && entry.id === selected);
    if (!account) throw new AccountError('Unknown account for the selected engine', 404);
    if (account.removing && !allowRemoving) throw new AccountError('This account is being removed. Retry after removal finishes.', 409);
    if (!supported(engine)) throw new AccountError('Named accounts are not supported by this engine', 501);
    const home = this.home(engine, account.id);
    const stat = fs.lstatSync(home, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AccountError('The selected account home is missing or invalid', 409);
    return { id: account.id, label: account.label };
  }

  list(engine) {
    const data = this.read();
    const defaultId = data.defaults[engine] ?? 'default';
    if (defaultId !== 'default' && !data.accounts.some((entry) => entry.engine === engine && entry.id === defaultId)) throw new AccountError('The engine default account is invalid', 409);
    return { supported: supported(engine), data: [{ id: 'default', label: 'Default' }, ...data.accounts.filter((entry) => entry.engine === engine).map(({ id, label }) => ({ id, label }))].map((entry) => ({ ...entry, isDefault: entry.id === defaultId })) };
  }

  create(engine, label) {
    if (!supported(engine)) throw new AccountError('Named accounts are not supported by this engine', 501);
    const parsed = labelSchema.safeParse(label);
    if (!parsed.success) throw new AccountError('Account name must contain 1 to 80 characters');
    const data = this.read();
    if (data.accounts.some((entry) => entry.engine === engine && entry.label.toLowerCase() === parsed.data.toLowerCase())) throw new AccountError('An account with this name already exists', 409);
    const account = { id: crypto.randomUUID(), label: parsed.data, engine };
    const home = this.home(engine, account.id);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // File storage binds Codex credentials to CODEX_HOME on every platform.
    if (engine === 'codex') fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    try { this.save({ ...data, accounts: [...data.accounts, account] }); }
    catch (error) { fs.rmSync(home, { recursive: true, force: true }); throw error; }
    return { id: account.id, label: account.label, isDefault: false };
  }

  setDefault(engine, id) {
    const data = this.read();
    const account = this.resolve(engine, id, data);
    this.save({ ...data, defaults: { ...data.defaults, [engine]: id } });
    return { ...account, isDefault: true };
  }

  resumeRemoval(engine, id) {
    const entry = this.read().accounts.find((account) => account.engine === engine && account.id === id);
    if (!entry?.removing) return;
    const home = this.home(engine, id);
    const retired = `${home}.retired`;
    const stat = fs.lstatSync(retired, { throwIfNoEntry: false });
    if (!fs.existsSync(home) && stat?.isDirectory() && !stat.isSymbolicLink()) fs.renameSync(retired, home);
  }

  setRemoving(engine, id, removing) {
    if (id === 'default') throw new AccountError('The ambient default account cannot be deleted', 409);
    const data = this.read();
    this.resolve(engine, id, data, true);
    this.save({ ...data, accounts: data.accounts.map((entry) => entry.engine === engine && entry.id === id ? { ...entry, removing } : entry) });
  }

  remove(engine, id) {
    if (id === 'default') throw new AccountError('The ambient default account cannot be deleted', 409);
    const data = this.read();
    this.resolve(engine, id, data, true);
    const defaults = { ...data.defaults };
    if (defaults[engine] === id) defaults[engine] = 'default';
    const home = this.home(engine, id);
    const retired = `${home}.retired`;
    fs.renameSync(home, retired);
    try { this.save({ ...data, accounts: data.accounts.filter((entry) => entry.id !== id), defaults }); }
    catch (error) { fs.renameSync(retired, home); throw error; }
    this.adapters.delete(`${engine}:${id}`);
    try { fs.rmSync(retired, { recursive: true, force: true }); }
    catch { throw new AccountError('Account removed, but its retired local files could not be cleaned up.', 500); }
  }

  environment(engine, id = 'default', inherited = process.env, allowRemoving = false) {
    if (id === 'default') return inherited;
    this.resolve(engine, id, undefined, allowRemoving);
    const env = { ...inherited };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CODEX_|OPENAI_|AZURE_OPENAI_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$)/i.test(key)) delete env[key];
    }
    const home = this.home(engine, id);
    env[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home;
    return env;
  }

  adapter(adapter, id, allowRemoving = false) {
    const account = this.resolve(adapter.id, id, undefined, allowRemoving);
    if (account.id === 'default') return adapter;
    const key = `${adapter.id}:${account.id}`;
    if (this.adapters.has(key)) return this.adapters.get(key);
    const context = () => ({ env: this.environment(adapter.id, account.id), isolated: true });
    let catalogError = null;
    const catalog = createModelCatalog({
      id: key,
      read: async () => {
        try {
          const result = await adapter.readAccountModels(context());
          catalogError = null;
          return result;
        } catch (error) { catalogError = error; throw error; }
      },
      identify: () => installedCliIdentity(adapter.installer),
      fallback: adapter.id === 'claude' ? CLAUDE_FALLBACK_CATALOG : CODEX_FALLBACK_CATALOG,
    });
    catalog.subscribe(() => { for (const listener of this.catalogListeners) listener(adapter.id, account.id); });
    const scoped = {
      ...adapter,
      ...modelCatalogMethods(catalog),
      modelCatalog: () => ({ ...catalog.current(), ...(catalogError ? { error: 'Model discovery failed for this account.' } : {}) }),
      ensureModelCatalog: async () => {
        await catalog.start();
        if (catalogError) throw new AccountError('Model discovery failed for the active account. Refresh its model list before retrying.', 503);
      },
      refreshModelCatalog: async () => { await catalog.start(); return catalog.refresh(); },
      accountId: account.id,
      accountEnvironment: () => context().env,
      loginKey: key,
      auth: {
        ...adapter.auth,
        status: () => adapter.auth.status(context()),
        logout: () => adapter.auth.logout(context()),
        ...(adapter.auth.loginProcess ? { loginProcess: () => {
          const spec = adapter.auth.loginProcess();
          return { ...spec, env: context().env, args: adapter.id === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', ...spec.args] : spec.args };
        } } : {}),
      },
    };
    this.adapters.set(key, scoped);
    return scoped;
  }
}

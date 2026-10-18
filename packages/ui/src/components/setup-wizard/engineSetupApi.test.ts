import { afterEach, describe, expect, test } from 'bun:test';
import { fetchEngineAuth, logoutEngine, parseEngineStatuses, refreshEngineModels, runEngineAction } from './engineSetupApi';

const legacyClaude = {
  engine: 'claude',
  displayName: 'Claude Code',
  providerID: 'anthropic',
  installed: true,
  version: '2.1.3',
  latestVersion: '2.2.0',
  updateAvailable: false,
  canInstall: true,
  installCommand: 'npm install -g @anthropic-ai/claude-code',
  state: 'idle',
  lastError: null,
  packageManager: null,
  rawVersion: '2.1.3 (Claude Code)',
  command: '/Users/me/.local/bin/claude',
  detection: { installed: true, stderr: '' },
};

describe('parseEngineStatuses', () => {
  test('an older server without actions or commands falls back to the install command', () => {
    const [status] = parseEngineStatuses({ data: [legacyClaude] });
    expect(status?.installSource).toBe('unknown');
    expect(status?.actions).toEqual({ install: true, update: true, reinstall: false, uninstall: false, doctor: false });
    expect(status?.commands.install).toBe('npm install -g @anthropic-ai/claude-code');
    expect(status?.commands.update).toBe('npm install -g @anthropic-ai/claude-code');
    expect(status?.commands.login).toBeNull();
    expect(status?.rawVersion).toBe('2.1.3 (Claude Code)');
    expect(status?.commandPath).toBe('/Users/me/.local/bin/claude');
    expect(status?.detectionError).toBeNull();
  });

  test('an npm install on an older server reads as npm', () => {
    const [status] = parseEngineStatuses({ data: [{ ...legacyClaude, packageManager: 'npm' }] });
    expect(status?.installSource).toBe('npm');
  });

  test('the contract fields are read as sent', () => {
    const [status] = parseEngineStatuses({
      data: [{
        ...legacyClaude,
        installSource: 'native',
        updateAvailable: true,
        state: 'running',
        action: 'update',
        actions: { install: true, update: true, reinstall: true, uninstall: true, doctor: false },
        commands: { install: 'curl x | bash', update: 'claude update', reinstall: 'claude install latest --force', uninstall: null, doctor: 'claude doctor', login: 'claude auth login', logout: 'claude auth logout' },
      }],
    });
    expect(status?.installSource).toBe('native');
    expect(status?.state).toBe('installing');
    expect(status?.currentAction).toBe('update');
    expect(status?.actions.doctor).toBe(false);
    expect(status?.commands.doctor).toBe('claude doctor');
    expect(status?.commands.uninstall).toBeNull();
  });

  test('a malformed field falls back instead of dropping the engine', () => {
    const [status] = parseEngineStatuses({ data: [{ ...legacyClaude, installSource: 'pip', actions: 'yes', detection: { stderr: 'boom' } }] });
    expect(status?.installSource).toBe('unknown');
    expect(status?.actions.install).toBe(true);
    expect(status?.detectionError).toBe('boom');
  });
});

describe('engine requests', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const calls: Array<{ url: string; body: string | null }> = [];
  const stubFetch = (handler: (url: string) => Response) => {
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      return handler(url);
    }) as typeof fetch;
  };

  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

  test('uninstall sends whether to remove the config', async () => {
    stubFetch(() => json({ status: 'started' }, 202));
    expect(await runEngineAction('codex', 'uninstall', { removeConfig: true })).toEqual({ kind: 'started' });
    expect(calls[0]?.url).toContain('/api/engines/codex/actions/uninstall');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ removeConfig: true });
  });

  test('an action the server cannot run returns its command', async () => {
    stubFetch(() => json({ error: 'not from here', command: 'agy update' }, 400));
    expect(await runEngineAction('antigravity', 'update')).toEqual({ kind: 'command', command: 'agy update', message: 'not from here' });
  });

  test('a busy engine answers busy', async () => {
    stubFetch(() => json({ error: 'busy' }, 409));
    expect(await runEngineAction('codex', 'reinstall')).toEqual({ kind: 'busy' });
  });

  test('install falls back to the older install route', async () => {
    stubFetch((url) => (url.includes('/actions/') ? json({ error: 'Not found' }, 404) : json({ status: 'installing' }, 200)));
    expect(await runEngineAction('codex', 'update')).toEqual({ kind: 'started' });
    expect(calls[1]?.url).toContain('/api/engines/codex/install');
  });

  test('an older server refusing install gives the install command', async () => {
    stubFetch((url) => (url.includes('/actions/') ? json({}, 404) : json({ error: 'no', installCommand: 'curl x | bash' }, 400)));
    expect(await runEngineAction('antigravity', 'install')).toEqual({ kind: 'command', command: 'curl x | bash', message: 'no' });
  });

  test('other actions on an older server fail', async () => {
    stubFetch(() => json({ error: 'Not found' }, 404));
    expect(await runEngineAction('codex', 'doctor')).toEqual({ kind: 'failed', message: 'Not found' });
    expect(calls).toHaveLength(1);
  });

  test('logout reports the server error', async () => {
    stubFetch(() => json({ error: 'Run claude auth logout' }, 501));
    expect(await logoutEngine('claude')).toEqual({ ok: false, message: 'Run claude auth logout' });
  });

  test('a model refresh reports how many models the engine lists, or why it failed', async () => {
    stubFetch(() => json({ engine: 'antigravity', models: [{ id: 'default' }, { id: 'gemini-4-argon' }], defaultModel: 'default', error: null }, 200));
    expect(await refreshEngineModels('antigravity')).toEqual({ ok: true, count: 2, message: null });
    expect(calls[0]?.url).toContain('/api/engines/antigravity/models/refresh');

    stubFetch(() => json({ engine: 'antigravity', models: [{ id: 'default' }], error: 'agy listed no models' }, 502));
    expect(await refreshEngineModels('antigravity')).toEqual({ ok: false, count: 1, message: 'agy listed no models' });
  });

  test('sign-in status keeps the account and drops an unknown plan', async () => {
    stubFetch(() => json({ loggedIn: true, email: 'a@b.c', authMethod: 'claude.ai', subscriptionType: 'unknown' }, 200));
    expect(await fetchEngineAuth('claude')).toEqual({ loggedIn: true, email: 'a@b.c', method: 'claude.ai', plan: null });
  });
});

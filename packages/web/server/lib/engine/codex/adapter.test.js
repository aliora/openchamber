import { describe, expect, it } from 'bun:test';
import { createEngineRegistry } from '../registry.js';
import { createFakeEngine } from '../test/fake-engine.js';
import { createCodexEngine, getCodexAuthStatus } from './adapter.js';
import { CodexProcess } from './codex-process.js';

const fakeInstaller = createFakeEngine().installer;

const runResult = (result) => async () => ({ code: 0, stdout: '', stderr: '', error: null, ...result });

describe('createCodexEngine', () => {
  it('describes the Codex CLI to the registry', () => {
    const codex = createCodexEngine({ installer: fakeInstaller });
    const registry = createEngineRegistry([codex]);

    expect(registry.get('codex')).toBe(codex);
    expect(codex.providerID).toBe('openai');
    // Until the server starts the read, the catalog is the fallback list, the CLI's default first.
    const { models, defaultModel } = codex.modelCatalog();
    expect(models[0].id).toBe(defaultModel);
    expect(codex.permissionModes).toEqual(['read-only', 'untrusted', 'on-request', 'never']);
    expect(codex.defaultPermissionMode).toBe('on-request');
    expect(codex.efforts).toContain(codex.defaultEffort);
  });

  it('creates a process with the injected spawn', () => {
    const spawnProcess = () => {
      throw new Error('not started in this test');
    };
    const codex = createCodexEngine({ installer: fakeInstaller, spawnProcess });
    const proc = codex.createProcess({ sessionId: 's1', cwd: '/work', model: 'gpt-5.5', effort: 'low', permissionMode: 'never', engineState: null });

    expect(proc).toBeInstanceOf(CodexProcess);
    expect(proc.spawnProcess).toBe(spawnProcess);
    expect(proc.policy).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' });
  });
});

describe('getCodexAuthStatus', () => {
  it('reads the sign-in method without returning what the CLI printed', async () => {
    const calls = [];
    const status = await getCodexAuthStatus({
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: 'Logged in using an API key - sk-proj-***ABCDE\n', error: null };
      },
    });

    expect(calls).toEqual([['login', 'status']]);
    expect(status).toEqual({ loggedIn: true, email: null, subscriptionType: 'unknown', authMethod: 'apikey' });
    expect(JSON.stringify(status)).not.toContain('sk-');
  });

  it('recognises a ChatGPT sign-in', async () => {
    const status = await getCodexAuthStatus({ run: runResult({ stderr: 'Logged in using ChatGPT\n' }) });
    expect(status.authMethod).toBe('chatgpt');
  });

  it('reports signed out when the CLI says so or cannot run', async () => {
    expect(await getCodexAuthStatus({ run: runResult({ code: 1, stderr: 'Not logged in\n' }) }))
      .toEqual({ loggedIn: false, email: null, reason: 'not_logged_in' });
    expect(await getCodexAuthStatus({ run: runResult({ code: null, error: 'spawn codex ENOENT' }) }))
      .toEqual({ loggedIn: false, email: null, reason: 'codex_unavailable' });
  });
});

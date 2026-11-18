import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@/lib/opencode/model';
import type { HostRequestInit } from './host-transport';
import { transferSession, type TransferHost } from './session-transfer';

const json = (body: JsonValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; path: string; body: JsonValue | undefined };

const host = (label: string, answers: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const request = async (path: string, init?: HostRequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${path}`];
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer();
  };
  const transferHost: TransferHost = { request, label, runtimeKey: `host:${label}` };
  return { host: transferHost, calls };
};

const BUNDLE = { version: 1, source: { sessionId: 's1' }, session: { title: 'Fix login' }, messages: [] };

type ImportedOverrides = { prompted?: boolean; gitTransferResult?: { applied: boolean; warning: string } };

const imported = (overrides: ImportedOverrides = {}) => () => json({
  data: { sessionId: 'new-1', directory: '/work/app', gitTransferResult: null, prompted: true, promptError: null, ...overrides },
}, 201);

describe('moving a session between hosts', () => {
  test('reads the bundle from the source, imports it on the target, then marks and archives the source', async () => {
    const source = host('MSI', {
      'GET /api/sessions/s1/transfer-bundle?includeGitChanges=1': () => json(BUNDLE),
      'POST /api/sessions/s1/mark-transferred': () => json({ data: {} }),
      'POST /api/openchamber/sessions/archive': () => json({ archived: [{ id: 's1' }], failedIds: [] }),
    });
    const target = host('Mac', { 'POST /api/sessions/import-transfer': imported() });

    const result = await transferSession({
      sessionId: 's1',
      source: source.host,
      target: target.host,
      includeGitChanges: true,
      archiveSource: true,
      prompt: '  Continue  ',
      model: { providerID: 'anthropic', id: 'sonnet' },
    });

    expect(result).toEqual({
      targetSessionId: 'new-1',
      directory: '/work/app',
      gitTransferResult: null,
      prompted: true,
      promptError: null,
      warnings: [],
    });
    expect(target.calls[0].body).toEqual({
      bundle: BUNDLE,
      applyGitChanges: true,
      sourceHostLabel: 'MSI',
      prompt: 'Continue',
      model: { providerID: 'anthropic', id: 'sonnet' },
    });
    expect(source.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/sessions/s1/transfer-bundle?includeGitChanges=1',
      'POST /api/sessions/s1/mark-transferred',
      'POST /api/openchamber/sessions/archive',
    ]);
    expect(source.calls[1].body).toEqual({ hostLabel: 'Mac', runtimeKey: 'host:Mac', targetSessionId: 'new-1', targetDirectory: '/work/app' });
    expect(source.calls[2].body).toEqual({ ids: ['s1'] });
  });

  test('leaves git changes, the prompt and the archive out when not asked', async () => {
    const source = host('MSI', {
      'GET /api/sessions/s1/transfer-bundle': () => json(BUNDLE),
      'POST /api/sessions/s1/mark-transferred': () => json({ data: {} }),
    });
    const target = host('Pi5', { 'POST /api/sessions/import-transfer': imported({ prompted: false }) });

    await transferSession({ sessionId: 's1', source: source.host, target: target.host, includeGitChanges: false, archiveSource: false, prompt: '   ' });

    expect(target.calls[0].body).toEqual({ bundle: BUNDLE, applyGitChanges: false, sourceHostLabel: 'MSI' });
    expect(source.calls).toHaveLength(2);
  });

  test('a source that refuses the bundle stops the move with its reason, and nothing is imported', async () => {
    const source = host('MSI', {
      'GET /api/sessions/s1/transfer-bundle': () => json({ error: 'The session is still answering' }, 409),
    });
    const target = host('Mac', {});

    await expect(transferSession({ sessionId: 's1', source: source.host, target: target.host, includeGitChanges: false, archiveSource: true }))
      .rejects.toThrow('The session is still answering');
    expect(target.calls).toHaveLength(0);
  });

  test('a failed import leaves the source untouched', async () => {
    const source = host('MSI', { 'GET /api/sessions/s1/transfer-bundle': () => json(BUNDLE) });
    const target = host('Mac', { 'POST /api/sessions/import-transfer': () => new Response('nope', { status: 500 }) });

    await expect(transferSession({ sessionId: 's1', source: source.host, target: target.host, includeGitChanges: false, archiveSource: true }))
      .rejects.toThrow('import-transfer answered 500');
    expect(source.calls.map((call) => call.path)).toEqual(['/api/sessions/s1/transfer-bundle']);
  });

  test('marking and archiving failures after the import come back as warnings', async () => {
    const source = host('MSI', {
      'GET /api/sessions/s1/transfer-bundle?includeGitChanges=1': () => json(BUNDLE),
      'POST /api/sessions/s1/mark-transferred': () => json({ error: 'gone' }, 404),
    });
    const target = host('Mac', { 'POST /api/sessions/import-transfer': imported({ gitTransferResult: { applied: false, warning: 'conflict' } }) });

    const result = await transferSession({ sessionId: 's1', source: source.host, target: target.host, includeGitChanges: true, archiveSource: true });

    expect(result.warnings).toEqual(['mark-failed', 'archive-failed']);
    expect(result.gitTransferResult).toEqual({ applied: false, warning: 'conflict' });
  });
});

import { describe, expect, test } from 'bun:test';

import { fetchHostModelProviders } from './host-model-catalog';
import type { HostRequestInit } from './host-transport';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const answering = (answers: Record<string, () => Response>) => {
  const paths: string[] = [];
  const request = async (path: string, init?: HostRequestInit) => {
    paths.push(`${init?.method ?? 'GET'} ${path}`);
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected ${path}`);
    return answer();
  };
  return { request, paths };
};

describe('a host\'s model catalog for the model picker', () => {
  test('groups the host\'s enabled models under its offerable providers', async () => {
    const { request, paths } = answering({
      '/api/provider': () => json({ location: {}, data: [
        { id: 'anthropic', name: 'Claude Code', activation: 'enabled' },
        { id: 'openai', name: 'Codex', activation: 'auto' },
        { id: 'google', name: 'Antigravity', activation: 'disabled' },
        { id: 'empty', name: 'No models' },
        { name: 'malformed' },
      ] }),
      '/api/model': () => json({ location: {}, data: [
        { id: 'sonnet', modelID: 'sonnet', providerID: 'anthropic', name: 'Claude Sonnet', enabled: true, variants: [{ id: 'high' }] },
        { id: 'haiku', modelID: 'haiku', providerID: 'anthropic', name: 'Claude Haiku', enabled: false },
        { id: 'gpt', modelID: 'gpt', providerID: 'openai', name: 'GPT', enabled: true, variants: null },
        { id: 'gemini', modelID: 'gemini', providerID: 'google', name: 'Gemini', enabled: true },
        { providerID: 'openai', enabled: true },
      ] }),
    });

    const providers = await fetchHostModelProviders(request);

    expect(paths.sort()).toEqual(['GET /api/model', 'GET /api/provider']);
    expect(providers.map((provider) => [provider.id, provider.name, provider.models?.map((model) => model.id)])).toEqual([
      ['anthropic', 'Claude Code', ['sonnet']],
      ['openai', 'Codex', ['gpt']],
    ]);
    expect(providers[0].models?.[0].variants).toEqual([{ id: 'high' }]);
    expect(providers[1].models?.[0].variants).toEqual([]);
  });

  test('a failed read throws instead of answering with no models', async () => {
    const { request } = answering({
      '/api/provider': () => json({ error: 'nope' }, 500),
      '/api/model': () => json({ location: {}, data: [] }),
    });
    await expect(fetchHostModelProviders(request)).rejects.toThrow();
  });
});

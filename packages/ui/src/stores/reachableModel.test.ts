import { describe, expect, test } from 'bun:test';

import { resolveReachableModel, type ModelReachability } from './reachableModel';

const catalogModel = (providerId: string, modelId: string) => ({ id: modelId, modelID: modelId, providerID: providerId });
const catalogProvider = (id: string, ...modelIds: string[]) => ({ id, models: modelIds.map((modelId) => catalogModel(id, modelId)) });

const PROVIDERS = [
  catalogProvider('anthropic', 'sonnet', 'opus'),
  catalogProvider('openai', 'gpt-6', 'gpt-6-mini'),
];

const reachability = (
  ready: string[],
  unavailable: string[] = [],
  catalogDefaults: Record<string, string> = {},
): ModelReachability => ({
  catalogDefaults,
  readiness: {
    ready: new Set(ready),
    unavailable: new Map(unavailable.map((id) => [id, { reason: 'not-installed' as const, fixCommand: null }])),
  },
});

const FABLE = { providerId: 'anthropic', modelId: 'fable' };

describe('resolveReachableModel', () => {
  test('a listed model stays', () => {
    const choice = { providerId: 'anthropic', modelId: 'opus' };
    expect(resolveReachableModel(choice, PROVIDERS, reachability(['anthropic']))).toEqual(choice);
  });

  test('a model its ready engine does not list moves to that engine’s catalog default', () => {
    expect(resolveReachableModel(FABLE, PROVIDERS, reachability(['anthropic'], [], { anthropic: 'opus' })))
      .toEqual({ providerId: 'anthropic', modelId: 'opus' });
  });

  test('without a catalog default for that engine, its first listed model stands in', () => {
    expect(resolveReachableModel(FABLE, PROVIDERS, reachability(['anthropic'], [], { openai: 'gpt-6-mini' })))
      .toEqual({ providerId: 'anthropic', modelId: 'sonnet' });
  });

  test('readiness not known yet keeps the configured model', () => {
    expect(resolveReachableModel(FABLE, PROVIDERS, reachability([]))).toEqual(FABLE);
  });

  test('a ready engine whose model list is not loaded yet keeps the configured model', () => {
    const choice = { providerId: 'google', modelId: 'gemini-4-argon' };
    expect(resolveReachableModel(choice, PROVIDERS, reachability(['google', 'anthropic']))).toEqual(choice);
  });

  test('an empty catalog keeps the configured model', () => {
    expect(resolveReachableModel(FABLE, [], reachability(['anthropic']))).toEqual(FABLE);
  });

  test('an engine that is not installed or signed out moves to the first ready engine’s default', () => {
    const choice = { providerId: 'google', modelId: 'gemini-4-argon' };
    expect(resolveReachableModel(choice, PROVIDERS, reachability(['openai', 'anthropic'], ['google'], { anthropic: 'opus' })))
      .toEqual({ providerId: 'openai', modelId: 'gpt-6' });
    expect(resolveReachableModel(choice, PROVIDERS, reachability(['google-other', 'anthropic'], ['google'], { anthropic: 'opus' })))
      .toEqual({ providerId: 'anthropic', modelId: 'opus' });
  });

  test('an unavailable engine with no ready engine listed keeps the configured model', () => {
    const choice = { providerId: 'google', modelId: 'gemini-4-argon' };
    expect(resolveReachableModel(choice, PROVIDERS, reachability([], ['google']))).toEqual(choice);
  });

  test('a provider without an engine, as Auto, stays', () => {
    const choice = { providerId: 'openchamber', modelId: 'auto' };
    expect(resolveReachableModel(choice, PROVIDERS, reachability(['anthropic'], ['google']))).toEqual(choice);
  });
});

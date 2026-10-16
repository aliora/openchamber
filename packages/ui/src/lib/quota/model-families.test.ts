import { describe, expect, test } from 'bun:test';

import { getDefaultModels } from './model-families';

describe('getDefaultModels', () => {
  test('selects every model Claude reports a limit for', () => {
    const models = ['Sonnet', 'Opus'];

    expect(getDefaultModels('claude', models)).toEqual(models);
  });

  test('selects nothing for a provider without per-model limits', () => {
    expect(getDefaultModels('codex', ['gpt-5'])).toEqual([]);
  });
});

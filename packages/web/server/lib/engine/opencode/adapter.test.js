import { describe, expect, test } from 'bun:test';

import { offeredEffort } from './adapter.js';

const models = [
  { id: 'opencode/big-pickle', efforts: [] },
  { id: 'openai/gpt-5.5', efforts: ['low', 'medium', 'high'] },
];

describe('offeredEffort', () => {
  test('passes an effort the model offers', () => {
    expect(offeredEffort(models, 'openai/gpt-5.5', 'medium')).toBe('medium');
  });

  test('drops the default effort of a model with no such variant', () => {
    expect(offeredEffort(models, 'opencode/big-pickle', 'medium')).toBeUndefined();
  });

  test('drops an effort for a model missing from the catalog', () => {
    expect(offeredEffort(models, 'unknown/model', 'medium')).toBeUndefined();
  });
});

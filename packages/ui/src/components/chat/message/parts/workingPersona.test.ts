import { describe, expect, test } from 'bun:test';

import { dict as enDict } from '@/lib/i18n/messages/en';
import { getWorkingPersona, getWorkingVerbKeys } from './workingPersona';

describe('getWorkingPersona', () => {
  test('maps Anthropic and Claude providers to the claude persona', () => {
    expect(getWorkingPersona('anthropic')).toBe('claude');
    expect(getWorkingPersona('claude')).toBe('claude');
    expect(getWorkingPersona('google-vertex-anthropic')).toBe('claude');
  });

  test('maps OpenAI, Codex and ChatGPT providers to the openai persona', () => {
    expect(getWorkingPersona('openai')).toBe('openai');
    expect(getWorkingPersona('codex')).toBe('openai');
    expect(getWorkingPersona('ChatGPT')).toBe('openai');
  });

  test('maps Google, Gemini and Antigravity providers to the gemini persona', () => {
    expect(getWorkingPersona('google')).toBe('gemini');
    expect(getWorkingPersona('gemini')).toBe('gemini');
    expect(getWorkingPersona('antigravity')).toBe('gemini');
  });

  test('lets the model id win over an aggregator provider', () => {
    expect(getWorkingPersona('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('claude');
    expect(getWorkingPersona('github-copilot', 'gpt-5.6-luna')).toBe('openai');
    expect(getWorkingPersona('antigravity', 'claude-opus-4.6')).toBe('claude');
    expect(getWorkingPersona('openrouter', 'google/gemini-3-pro')).toBe('gemini');
  });

  test('falls back to the provider when the model id names no family', () => {
    expect(getWorkingPersona('anthropic', 'big-pickle')).toBe('claude');
  });

  test('uses the default persona for unknown or missing providers', () => {
    expect(getWorkingPersona('ollama', 'qwen3-coder')).toBe('default');
    expect(getWorkingPersona(null)).toBe('default');
    expect(getWorkingPersona(undefined, undefined)).toBe('default');
  });
});

describe('getWorkingVerbKeys', () => {
  test('gives each branded persona several verbs and the default none', () => {
    expect(getWorkingVerbKeys('claude').length).toBeGreaterThan(1);
    expect(getWorkingVerbKeys('openai').length).toBeGreaterThan(1);
    expect(getWorkingVerbKeys('gemini').length).toBeGreaterThan(1);
    expect(getWorkingVerbKeys('default')).toEqual([]);
  });

  test('every verb key exists in the English dictionary', () => {
    const keys = (['claude', 'openai', 'gemini'] as const).flatMap(getWorkingVerbKeys);
    for (const key of keys) {
      expect(typeof enDict[key]).toBe('string');
    }
  });
});

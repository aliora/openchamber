import { describe, expect, test } from 'bun:test';

import { sessionSortI18n } from './session-sort.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('session sort translations', () => {
  test('every locale has every key', () => {
    const keys = Object.keys(sessionSortI18n.en);
    for (const locale of locales) {
      const translated: Record<string, string> = sessionSortI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) expect(translated[key].trim().length).toBeGreaterThan(0);
    }
  });
});

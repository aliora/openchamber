import { describe, expect, test } from 'bun:test';

import { engineModelsI18n } from './engine-models.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('engine model list translations', () => {
  test('provides every key in every supported locale, translated, with the count placeholder', () => {
    const english: Record<string, string> = engineModelsI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = engineModelsI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en') expect(translated[key]).not.toBe(english[key]);
      }
      expect(translated['engines.models.refreshed']).toContain('{count}');
    }
  });
});

import { describe, expect, test } from 'bun:test';

import { draftHostI18n } from './draft-host.i18n';

const locales = ['en', 'tr', 'de', 'fr', 'es', 'nl', 'pl', 'pt-BR', 'uk', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

describe('draft host translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(draftHostI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(draftHostI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (key.endsWith('InProject')) expect(dictionary.get(key)).toContain('{project}');
        if (locale !== 'en') expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
      }
    }
  });
});

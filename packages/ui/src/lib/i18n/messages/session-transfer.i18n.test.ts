import { describe, expect, test } from 'bun:test';

import { sessionTransferI18n } from './session-transfer.i18n';

const locales = ['en', 'tr', 'de', 'fr', 'es', 'nl', 'pl', 'pt-BR', 'uk', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

describe('session transfer translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(sessionTransferI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(sessionTransferI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        for (const placeholder of englishText.match(/\{\w+\}/g) ?? []) expect(dictionary.get(key)).toContain(placeholder);
        if (locale !== 'en') expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
      }
    }
  });
});

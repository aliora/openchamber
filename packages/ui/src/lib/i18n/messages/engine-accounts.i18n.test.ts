import { describe, expect, test } from 'bun:test';

import { LOCALES } from '../runtime';
import { engineAccountsI18n } from './engine-accounts.i18n';

// Words that are the same in the language as in English.
const SAME_AS_ENGLISH = new Set([
  'nl engines.accounts.title',
  'nl chat.composer.account.title',
]);

describe('engine account translations', () => {
  test('every locale has every key, translated, with the English placeholders', () => {
    const english = Object.entries(engineAccountsI18n.en);
    for (const locale of LOCALES) {
      const dictionary = new Map<string, string>(Object.entries(engineAccountsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(text.trim()).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(`${locale} ${key}`)) {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
        for (const placeholder of englishText.match(/\{\w+\}/g) ?? []) {
          expect(`${locale} ${key}: ${text}`).toContain(placeholder);
        }
      }
    }
  });
});

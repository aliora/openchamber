import { describe, expect, test } from 'bun:test';

import { LOCALES } from '../runtime';
import { composerControlsI18n } from './composer-controls.i18n';

// Words that are the same in the language as in English.
const SAME_AS_ENGLISH = new Set([
  'de chat.composer.effort.level.ultra.label',
  'fr chat.composer.effort.level.ultra.label',
  'nl chat.composer.effort.level.ultra.label',
  'es chat.composer.effort.level.ultra.label',
  'pt-BR chat.composer.effort.level.ultra.label',
  'pl chat.composer.effort.level.ultra.label',
  'tr chat.composer.effort.level.ultra.label',
]);

describe('composer control translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(composerControlsI18n.en);
    for (const locale of LOCALES) {
      const dictionary = new Map<string, string>(Object.entries(composerControlsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(text.trim()).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(`${locale} ${key}`)) {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
        // A placeholder the English text has stays in the translation.
        for (const placeholder of englishText.match(/\{\w+\}/g) ?? []) {
          expect(`${locale} ${key}: ${text}`).toContain(placeholder);
        }
      }
    }
  });
});

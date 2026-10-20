import { describe, expect, test } from 'bun:test';

import { hostsI18n } from './hosts.i18n';

const locales = ['en', 'tr', 'de', 'fr', 'es', 'nl', 'pl', 'pt-BR', 'uk', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

describe('hosts translations', () => {
  test('every locale has every key, translated, with its host placeholder', () => {
    const english = Object.entries(hostsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(hostsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (englishText.includes('{host}')) expect(dictionary.get(key)).toContain('{host}');
        if (locale !== 'en') expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
      }
    }
  });
});

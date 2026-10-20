import { describe, expect, test } from 'bun:test';

import { settingsSyncI18n } from './settings-sync.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('sync settings translations', () => {
  test('every locale has every key with the same placeholders', () => {
    const english: Record<string, string> = settingsSyncI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = settingsSyncI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key].trim().length).toBeGreaterThan(0);
        expect(placeholdersOf(translated[key])).toEqual(placeholdersOf(english[key]));
      }
    }
  });

  test('sentences are translated, not copied from English', () => {
    const english: Record<string, string> = settingsSyncI18n.en;
    for (const locale of locales.filter((entry) => entry !== 'en')) {
      const translated: Record<string, string> = settingsSyncI18n[locale];
      for (const key of ['settings.page.sync.description', 'settings.sync.empty.same', 'settings.sync.section.differencesInfo', 'settings.sync.sourceUnreachable']) {
        expect(translated[key]).not.toBe(english[key]);
      }
    }
  });
});

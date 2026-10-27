import { describe, expect, test } from 'bun:test';

import { scheduledTaskNotifyI18n } from './scheduled-task-notify.i18n';

const locales = ['en', 'tr', 'de', 'fr', 'es', 'nl', 'pl', 'pt-BR', 'uk', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

describe('scheduled task notify translations', () => {
  test('every locale has every key, translated, with its placeholders', () => {
    const english = Object.entries(scheduledTaskNotifyI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(scheduledTaskNotifyI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
      }
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { engineAccountPath, engineAccountsSchema } from './engineAccounts';
import { engineAccountsI18n } from './i18n/messages/engine-accounts.i18n';

describe('engine account boundary', () => {
  test('distinguishes unsupported, empty, and malformed account responses', () => {
    expect(engineAccountsSchema.parse({ data: [], supported: false }).supported).toBe(false);
    expect(engineAccountsSchema.parse({ data: [], supported: true }).data).toEqual([]);
    expect(engineAccountsSchema.safeParse({ data: [{ id: 'a', label: 'Work' }], supported: true }).success).toBe(false);
    expect(engineAccountsSchema.safeParse({ supported: true }).success).toBe(false);
  });
  test('encodes account identifiers as one path segment', () => {
    expect(engineAccountPath('codex', 'work/other?key')).toBe('/api/engines/codex/accounts/work%2Fother%3Fkey');
  });
  test('every locale translates the active-account strings without replacement corruption', () => {
    const english = engineAccountsI18n.en;
    for (const [locale, messages] of Object.entries(engineAccountsI18n)) {
      expect(Object.keys(messages)).toEqual(Object.keys(english));
      expect(Object.values(messages).every((message) => !message.includes('?') && !message.includes('\uFFFD'))).toBe(true);
      if (locale !== 'en') expect(messages['engines.accounts.info']).not.toBe(english['engines.accounts.info']);
    }
  });
});

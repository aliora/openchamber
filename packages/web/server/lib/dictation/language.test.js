import { describe, expect, it } from 'vitest';

import { toSpeechLanguageCode, toWhisperLanguage } from './language.js';

describe('speech language codes', () => {
  it('reduces a locale to its primary subtag and treats auto or blank as detection', () => {
    expect(toSpeechLanguageCode('tr-TR')).toBe('tr');
    expect(toSpeechLanguageCode(' EN ')).toBe('en');
    expect(toSpeechLanguageCode('auto')).toBe('');
    expect(toSpeechLanguageCode('')).toBe('');
    expect(toSpeechLanguageCode(undefined)).toBe('');
  });

  it('gives Whisper only codes it knows, so a typo cannot end the worker', () => {
    expect(toWhisperLanguage('tr')).toBe('tr');
    expect(toWhisperLanguage('xx')).toBe('');
    expect(toWhisperLanguage('auto')).toBe('');
  });
});

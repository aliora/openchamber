import { describe, expect, test } from 'bun:test';

import {
  formatSttVocabulary,
  isSttProvider,
  parseSttVocabularyText,
  resolveSttLocalModel,
} from './stt-preferences';

describe('resolveSttLocalModel', () => {
  test('keeps the model the person chose', () => {
    expect(resolveSttLocalModel({ chosen: 'whisper-base-int8', locale: 'tr', language: '' })).toBe('whisper-base-int8');
  });

  test('picks Whisper turbo for a Turkish interface with automatic or Turkish language', () => {
    expect(resolveSttLocalModel({ chosen: '', locale: 'tr', language: '' })).toBe('whisper-turbo-int8');
    expect(resolveSttLocalModel({ chosen: '', locale: 'tr', language: 'auto' })).toBe('whisper-turbo-int8');
    expect(resolveSttLocalModel({ chosen: '', locale: 'en', language: 'tr-TR' })).toBe('whisper-turbo-int8');
  });

  test('keeps the English default otherwise', () => {
    expect(resolveSttLocalModel({ chosen: '', locale: 'en', language: '' })).toBe('parakeet-tdt-0.6b-v2-int8');
    expect(resolveSttLocalModel({ chosen: '', locale: 'tr', language: 'en' })).toBe('parakeet-tdt-0.6b-v2-int8');
  });
});

describe('vocabulary text', () => {
  test('splits on commas and new lines, trims, and drops duplicates', () => {
    expect(parseSttVocabularyText('zone, gate\nlens,, zone \n Pi5')).toEqual(['zone', 'gate', 'lens', 'Pi5']);
  });

  test('round-trips through the field text', () => {
    expect(parseSttVocabularyText(formatSttVocabulary(['commit', 'deploy']))).toEqual(['commit', 'deploy']);
  });
});

describe('isSttProvider', () => {
  test('accepts the three providers only', () => {
    expect(isSttProvider('elevenlabs')).toBe(true);
    expect(isSttProvider('local')).toBe(true);
    expect(isSttProvider('server')).toBe(false);
    expect(isSttProvider(null)).toBe(false);
  });
});

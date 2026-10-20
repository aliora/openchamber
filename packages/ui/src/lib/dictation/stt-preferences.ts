import { z } from 'zod';

const STT_PROVIDERS = ['local', 'openai-compatible', 'elevenlabs'] as const;

export type SttProvider = (typeof STT_PROVIDERS)[number];

const sttProviderSchema = z.enum(STT_PROVIDERS);

export const isSttProvider = (value: string | null | undefined): value is SttProvider => sttProviderSchema.safeParse(value).success;

const DEFAULT_STT_LOCAL_MODEL = 'parakeet-tdt-0.6b-v2-int8';
const TURKISH_STT_LOCAL_MODEL = 'whisper-turbo-int8';

const primaryLanguage = (value: string): string => value.trim().toLowerCase().split(/[-_]/)[0] ?? '';

export const resolveSttLocalModel = ({ chosen, locale, language }: {
  chosen: string;
  locale: string;
  language: string;
}): string => {
  if (chosen.trim()) return chosen;
  const spoken = primaryLanguage(language);
  const detectsLanguage = spoken === '' || spoken === 'auto';
  const turkish = spoken === 'tr' || (detectsLanguage && primaryLanguage(locale) === 'tr');
  return turkish ? TURKISH_STT_LOCAL_MODEL : DEFAULT_STT_LOCAL_MODEL;
};

export const parseSttVocabularyText = (text: string): string[] => {
  const terms = text.split(/[,\n]/).map((term) => term.trim()).filter((term) => term.length > 0);
  return [...new Set(terms)];
};

export const formatSttVocabulary = (terms: readonly string[]): string => terms.join(', ');

import { z } from 'zod';

const languageInputSchema = z.string().catch('');

/**
 * @param {unknown} language
 * @returns {string}
 */
export function toSpeechLanguageCode(language) {
  const primary = languageInputSchema.parse(language).trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

const WHISPER_LANGUAGE_CODES = new Set(
  ('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt '
    + 'la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc '
    + 'ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su').split(' '),
);

/**
 * @param {unknown} language
 * @returns {string}
 */
export function toWhisperLanguage(language) {
  const code = toSpeechLanguageCode(language);
  return WHISPER_LANGUAGE_CODES.has(code) ? code : '';
}

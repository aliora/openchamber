import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_TTS_MODEL_CATALOG,
  getLocalSttModelSpec,
  getLocalTtsDefaultSpeaker,
  resolveLocalSttModelId,
  resolveLocalTtsModelForLanguage,
} from './model-catalog.js';

describe('local TTS catalog', () => {
  it('keeps the selected model when it speaks the language', () => {
    expect(resolveLocalTtsModelForLanguage('en', DEFAULT_LOCAL_TTS_MODEL)).toBe(DEFAULT_LOCAL_TTS_MODEL);
    expect(resolveLocalTtsModelForLanguage('zh', 'kokoro-multi-lang-v1_1')).toBe('kokoro-multi-lang-v1_1');
  });

  it('picks a catalog model for a language the selected model lacks', () => {
    expect(resolveLocalTtsModelForLanguage('uk', DEFAULT_LOCAL_TTS_MODEL)).toBe('piper-uk_UA-lada-x_low');
    expect(resolveLocalTtsModelForLanguage('zh', DEFAULT_LOCAL_TTS_MODEL)).toBe('kokoro-multi-lang-v1_1');
  });

  it('returns null for a language no model covers', () => {
    expect(resolveLocalTtsModelForLanguage('xx', DEFAULT_LOCAL_TTS_MODEL)).toBeNull();
  });

  it('gives Chinese a Chinese speaker on the multi-language Kokoro', () => {
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'zh')).toBe(3);
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'en')).toBe(0);
    expect(getLocalTtsDefaultSpeaker('piper-uk_UA-lada-x_low', 'uk')).toBeUndefined();
  });

  it('every TTS entry declares its languages and installable files', () => {
    for (const [id, spec] of Object.entries(LOCAL_TTS_MODEL_CATALOG)) {
      expect(spec.languages.length, id).toBeGreaterThan(0);
      expect(spec.archiveUrl, id).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\//);
      const resolved = getLocalSttModelSpec(id);
      expect(resolved.requiredFiles, id).toContain(spec.files.model);
      for (const key of spec.lexicon ?? []) {
        expect(spec.files[key], `${id} lexicon ${key}`).toBeTruthy();
      }
    }
  });
});

describe('local STT catalog', () => {
  it('offers Whisper large-v3 turbo from the official sherpa-onnx release with its int8 files', () => {
    const spec = getLocalSttModelSpec('whisper-turbo-int8');
    expect(spec.type).toBe('whisper');
    expect(spec.archiveUrl).toBe('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2');
    expect(spec.extractedDir).toBe('sherpa-onnx-whisper-turbo');
    expect(spec.requiredFiles).toEqual(['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt']);
  });

  it('keeps a requested model and picks turbo only for Turkish when none is chosen', () => {
    expect(resolveLocalSttModelId('whisper-base-int8', 'tr')).toBe('whisper-base-int8');
    expect(resolveLocalSttModelId(undefined, 'tr')).toBe('whisper-turbo-int8');
    expect(resolveLocalSttModelId('', '')).toBe('parakeet-tdt-0.6b-v2-int8');
    expect(resolveLocalSttModelId('not-a-model', 'en')).toBe('parakeet-tdt-0.6b-v2-int8');
  });
});

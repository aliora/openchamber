import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeVoiceKeys, readVoiceKey, updateVoiceKeys } from './voice-keys.js';

describe('voice keys store', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-voice-keys-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps keys in an owner-only file and answers only whether each is set', () => {
    expect(updateVoiceKeys({ openai: ' sk-openai ', stt: 'sk-stt' })).toEqual({ openai: true, openaiCompatible: false, stt: true, elevenlabs: false });
    expect(readVoiceKey('openai')).toBe('sk-openai');
    expect(JSON.stringify(describeVoiceKeys())).not.toContain('sk-');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'voice-keys.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('removes a key on null and leaves the others alone', () => {
    updateVoiceKeys({ openai: 'sk-openai', openaiCompatible: 'sk-compat' });
    expect(updateVoiceKeys({ openai: null })).toEqual({ openai: false, openaiCompatible: true, stt: false, elevenlabs: false });
    expect(readVoiceKey('openaiCompatible')).toBe('sk-compat');
  });

  it('stores the ElevenLabs key beside the others and answers only that it is set', () => {
    expect(updateVoiceKeys({ elevenlabs: 'sk_eleven' })).toEqual({ openai: false, openaiCompatible: false, stt: false, elevenlabs: true });
    expect(readVoiceKey('elevenlabs')).toBe('sk_eleven');
    expect(JSON.stringify(describeVoiceKeys())).not.toContain('sk_eleven');
  });

  it('refuses a malformed patch without touching what is stored', () => {
    updateVoiceKeys({ openai: 'sk-openai' });
    expect(() => updateVoiceKeys({ openai: 42 })).toThrow();
    expect(() => updateVoiceKeys({ somethingElse: 'x' })).toThrow();
    expect(readVoiceKey('openai')).toBe('sk-openai');
  });
});

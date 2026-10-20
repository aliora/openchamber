import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDictationService } from './service.js';
import { ElevenLabsTranscriptionSession } from './elevenlabs-session.js';
import { updateVoiceKeys } from '../tts/voice-keys.js';

const API_KEY = 'sk_service_test_key';

describe('dictation service with ElevenLabs', () => {
  let dataDir;
  let previousDataDir;
  let service;
  let consoleWarn;

  const createService = (fetchImpl) => createDictationService({
    modelsDir: path.join(dataDir, 'speech-models'),
    usageFilePath: path.join(dataDir, 'dictation-usage.json'),
    fetchImpl,
  });

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dictation-service-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service?.shutdown();
    service = undefined;
    consoleWarn.mockRestore();
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers not configured while no ElevenLabs key is stored', async () => {
    service = createService(vi.fn());
    const result = await service.createSttSession({ provider: 'elevenlabs' });
    expect(result).toMatchObject({ reasonCode: 'stt_not_configured', retryable: false });
    expect(await service.getStatus({ provider: 'elevenlabs' })).toMatchObject({
      provider: 'elevenlabs',
      available: false,
      reasonCode: 'stt_not_configured',
    });
  });

  it('opens a Scribe session with the stored key and the vocabulary, and counts the minutes', async () => {
    updateVoiceKeys({ elevenlabs: API_KEY });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'zone deploy edildi' }), { status: 200 }));
    service = createService(fetchImpl);

    const result = await service.createSttSession({ provider: 'elevenlabs', vocabulary: ['zone', 'deploy'] });
    expect(result.session).toBeInstanceOf(ElevenLabsTranscriptionSession);

    const transcript = new Promise((resolve) => result.session.once('transcript', resolve));
    result.session.appendPcm16(Buffer.alloc(16000 * 2 * 3, 1));
    result.session.commit();
    expect((await transcript).transcript).toBe('zone deploy edildi');
    expect(fetchImpl.mock.calls[0][1].body.getAll('keyterms')).toEqual(['zone', 'deploy']);

    const status = await service.getStatus({ provider: 'elevenlabs' });
    expect(status).toMatchObject({ provider: 'elevenlabs', available: true });
    expect(status.cloudUsage.elevenlabsSeconds).toBe(3);
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it('reports the cloud error when the cloud fails and no local model is installed', async () => {
    updateVoiceKeys({ elevenlabs: API_KEY });
    service = createService(vi.fn(async () => new Response('{}', { status: 401 })));
    const { session } = await service.createSttSession({ provider: 'elevenlabs' });

    const error = new Promise((resolve) => session.once('error', resolve));
    session.appendPcm16(Buffer.alloc(3200, 1));
    session.commit();
    const emitted = await error;
    expect(emitted.reasonCode).toBe('stt_not_configured');
    expect(emitted.message).not.toContain(API_KEY);
    for (const call of consoleWarn.mock.calls) {
      expect(call.join(' ')).not.toContain(API_KEY);
    }
  });
});

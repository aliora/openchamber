import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsTranscriptionSession, toElevenLabsKeyterms } from './elevenlabs-session.js';

const API_KEY = 'sk_test_elevenlabs_secret';

const loudPcm16 = (samples = 16000) => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
  }
  return buffer;
};

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const nextEvent = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));

const createSession = async (overrides = {}) => {
  const fetchImpl = overrides.fetchImpl ?? vi.fn(async () => jsonResponse(200, { text: ' merhaba deploy ' }));
  const session = new ElevenLabsTranscriptionSession({
    apiKey: API_KEY,
    language: '',
    keyterms: [],
    fetchImpl,
    ...overrides,
  });
  await session.connect();
  return { session, fetchImpl };
};

const commitOneSegment = (session) => {
  session.appendPcm16(loudPcm16());
  session.commit();
};

describe('ElevenLabsTranscriptionSession', () => {
  afterEach(() => {
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  });

  it('sends each committed segment as a WAV file to Scribe v2 with the key in the header', async () => {
    const { session, fetchImpl } = await createSession();
    const transcript = nextEvent(session, 'transcript');
    commitOneSegment(session);

    expect(await transcript).toMatchObject({ transcript: 'merhaba deploy', isFinal: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe(API_KEY);
    const body = init.body;
    expect(body.get('model_id')).toBe('scribe_v2');
    expect(body.get('tag_audio_events')).toBe('false');
    expect(body.has('language_code')).toBe(false);
    const file = body.get('file');
    expect(file.type).toBe('audio/wav');
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('passes a chosen language and the vocabulary as keyterms', async () => {
    const { session, fetchImpl } = await createSession({
      language: 'tr-TR',
      keyterms: ['zone', 'Pi5', 'commit'],
    });
    const transcript = nextEvent(session, 'transcript');
    commitOneSegment(session);
    await transcript;

    const body = fetchImpl.mock.calls[0][1].body;
    expect(body.get('language_code')).toBe('tr');
    expect(body.getAll('keyterms')).toEqual(['zone', 'Pi5', 'commit']);
  });

  it('records the seconds of audio the cloud transcribed', async () => {
    const recordUsage = vi.fn();
    const { session } = await createSession({ recordUsage });
    const transcript = nextEvent(session, 'transcript');
    commitOneSegment(session);
    await transcript;

    expect(recordUsage).toHaveBeenCalledWith(1);
  });

  it('refuses to connect without a key', async () => {
    const session = new ElevenLabsTranscriptionSession({ apiKey: undefined, fetchImpl: vi.fn() });
    await expect(session.connect()).rejects.toThrow(/API key/);
  });

  it('refuses to connect in enterprise mode', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const session = new ElevenLabsTranscriptionSession({ apiKey: API_KEY, fetchImpl: vi.fn() });
    await expect(session.connect()).rejects.toThrow(/enterprise mode/i);
  });

  it.each([
    [401, 'stt_not_configured'],
    [402, 'stt_quota_exceeded'],
    [429, 'stt_quota_exceeded'],
    [500, 'stt_unavailable'],
  ])('maps HTTP %i to reason code %s and never leaks the key', async (status, reasonCode) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { detail: { status: 'quota_exceeded', message: `bad key ${API_KEY}` } }));
    const { session } = await createSession({ fetchImpl });
    const error = nextEvent(session, 'error');
    commitOneSegment(session);

    const emitted = await error;
    expect(emitted.reasonCode).toBe(reasonCode);
    expect(emitted.message).not.toContain(API_KEY);
    expect(JSON.stringify(emitted)).not.toContain(API_KEY);
  });

  it('transcribes the segment locally and tells the client once when the cloud fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { detail: { status: 'too_many_requests' } }));
    const transcribeFallback = vi.fn(async () => 'yerel metin');
    const { session } = await createSession({ fetchImpl, transcribeFallback });
    const notices = [];
    session.on('notice', (notice) => notices.push(notice));
    const transcripts = [];
    session.on('transcript', (payload) => transcripts.push(payload.transcript));

    commitOneSegment(session);
    await nextEvent(session, 'transcript');
    commitOneSegment(session);
    await nextEvent(session, 'transcript');

    expect(transcripts).toEqual(['yerel metin', 'yerel metin']);
    expect(transcribeFallback).toHaveBeenCalledTimes(2);
    expect(transcribeFallback.mock.calls[0][0]).toBeInstanceOf(Buffer);
    expect(notices).toEqual([{ reasonCode: 'stt_cloud_fallback_local' }]);
  });

  it('falls back on a network failure without counting cloud usage', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const recordUsage = vi.fn();
    const { session } = await createSession({ fetchImpl, recordUsage, transcribeFallback: async () => 'yerel' });
    const transcript = nextEvent(session, 'transcript');
    commitOneSegment(session);

    expect((await transcript).transcript).toBe('yerel');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('reports the cloud error when no local model can take over', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, {}));
    const { session } = await createSession({ fetchImpl, transcribeFallback: async () => null });
    const error = nextEvent(session, 'error');
    commitOneSegment(session);

    expect((await error).reasonCode).toBe('stt_quota_exceeded');
  });
});

describe('toElevenLabsKeyterms', () => {
  it('keeps the terms Scribe accepts, trimmed and without duplicates', () => {
    expect(toElevenLabsKeyterms([' zone ', 'zone', '', 'a very long phrase with too many words', 'bad<term>', 'x'.repeat(50), 'Pi5'])).toEqual(['zone', 'Pi5']);
  });

  it('caps the list at 100 terms so no minimum billable duration applies', () => {
    const terms = Array.from({ length: 150 }, (_, index) => `term${index}`);
    expect(toElevenLabsKeyterms(terms)).toHaveLength(100);
  });
});

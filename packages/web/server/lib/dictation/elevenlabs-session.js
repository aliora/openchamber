import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { pcm16ToWav } from './audio.js';
import { toSpeechLanguageCode } from './language.js';

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_STT_MODEL = 'scribe_v2';
const ELEVENLABS_SAMPLE_RATE = 16000;
const ELEVENLABS_REQUEST_TIMEOUT_MS = 20000;
const KEYTERM_MAX_COUNT = 100;
const KEYTERM_MAX_LENGTH = 49;
const KEYTERM_MAX_WORDS = 5;
const KEYTERM_FORBIDDEN = /[<>{}[\]\\]/;
const CLOUD_FALLBACK_REASON_CODE = 'stt_cloud_fallback_local';

const keytermSchema = z.string().trim().min(1).max(KEYTERM_MAX_LENGTH).refine(
  (term) => !KEYTERM_FORBIDDEN.test(term) && term.split(/\s+/).length <= KEYTERM_MAX_WORDS,
);
const errorBodySchema = z.object({ detail: z.object({ status: z.string().regex(/^[a-z_]{1,64}$/) }) });
const transcriptBodySchema = z.object({ text: z.string() });

/**
 * @param {unknown} terms
 * @returns {string[]}
 */
export function toElevenLabsKeyterms(terms) {
  if (!Array.isArray(terms)) {
    return [];
  }
  const accepted = new Set();
  for (const term of terms) {
    const parsed = keytermSchema.safeParse(term);
    if (!parsed.success) continue;
    accepted.add(parsed.data);
    if (accepted.size === KEYTERM_MAX_COUNT) break;
  }
  return [...accepted];
}

const reasonCodeForStatus = (status) => {
  if (status === 401 || status === 403) return 'stt_not_configured';
  if (status === 402 || status === 429) return 'stt_quota_exceeded';
  return 'stt_unavailable';
};

const readDetailStatus = async (response) => {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.detail.status : null;
};

const createCloudError = (message, reasonCode) => {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
};

export class ElevenLabsTranscriptionSession extends EventEmitter {
  /**
   * @param {{ apiKey?: string, language?: string, keyterms?: string[],
   *           fetchImpl?: typeof fetch,
   *           transcribeFallback?: (pcm16: Buffer) => Promise<string | null>,
   *           recordUsage?: (seconds: number) => void }} config
   */
  constructor({ apiKey, language, keyterms, fetchImpl = fetch, transcribeFallback, recordUsage }) {
    super();
    this.apiKey = apiKey;
    this.languageCode = toSpeechLanguageCode(language);
    this.keyterms = toElevenLabsKeyterms(keyterms);
    this.fetchImpl = fetchImpl;
    this.transcribeFallback = transcribeFallback;
    this.recordUsage = recordUsage;
    this.requiredSampleRate = ELEVENLABS_SAMPLE_RATE;
    this.connected = false;
    this.fallbackNoticeSent = false;
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }

  async connect() {
    if (isEnterpriseMode()) {
      throw new Error('In enterprise mode transcription stays on this machine; ElevenLabs is not available.');
    }
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key is not configured');
    }
    this.connected = true;
  }

  appendPcm16(chunk) {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
  }

  commit() {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }
    const committedId = this.segmentId;
    const previousSegmentId = this.previousSegmentId;
    const committedPcm16 = this.pcm16;
    this.previousSegmentId = committedId;
    this.segmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);
    this.emit('committed', { segmentId: committedId, previousSegmentId });

    void this.transcribeSegment(committedId, committedPcm16);
  }

  async transcribeSegment(segmentId, pcm16) {
    let transcript;
    try {
      transcript = await this.requestTranscript(pcm16);
      this.recordUsage?.(pcm16.length / 2 / ELEVENLABS_SAMPLE_RATE);
    } catch (cloudError) {
      transcript = await this.transcribeWithFallback(pcm16, cloudError);
      if (transcript === null) {
        this.emit('error', cloudError);
        return;
      }
    }
    this.emit('transcript', { segmentId, transcript, isFinal: true });
  }

  async transcribeWithFallback(pcm16, cloudError) {
    if (!this.transcribeFallback) {
      return null;
    }
    let text;
    try {
      text = await this.transcribeFallback(pcm16);
    } catch {
      return null;
    }
    if (text === null) {
      return null;
    }
    if (!this.fallbackNoticeSent) {
      this.fallbackNoticeSent = true;
      this.emit('notice', { reasonCode: CLOUD_FALLBACK_REASON_CODE });
    }
    console.warn(`[dictation] ElevenLabs failed (${cloudError.reasonCode}); segment transcribed locally`);
    return text.trim();
  }

  async requestTranscript(pcm16) {
    const form = new FormData();
    form.append('model_id', ELEVENLABS_STT_MODEL);
    form.append('tag_audio_events', 'false');
    if (this.languageCode) {
      form.append('language_code', this.languageCode);
    }
    for (const term of this.keyterms) {
      form.append('keyterms', term);
    }
    form.append('file', new Blob([pcm16ToWav(pcm16, ELEVENLABS_SAMPLE_RATE)], { type: 'audio/wav' }), 'segment.wav');

    let response;
    try {
      response = await this.fetchImpl(ELEVENLABS_STT_URL, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey },
        body: form,
        signal: AbortSignal.timeout(ELEVENLABS_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw createCloudError('Could not reach ElevenLabs', 'stt_unavailable');
    }

    if (!response.ok) {
      const detail = await readDetailStatus(response);
      throw createCloudError(
        `ElevenLabs transcription failed (HTTP ${response.status}${detail ? `, ${detail}` : ''})`,
        reasonCodeForStatus(response.status),
      );
    }

    const body = transcriptBodySchema.safeParse(await response.json().catch(() => null));
    if (!body.success) {
      throw createCloudError('ElevenLabs returned no transcript', 'stt_unavailable');
    }
    return body.data.text.trim();
  }

  clear() {
    this.pcm16 = Buffer.alloc(0);
    this.segmentId = randomUUID();
  }

  close() {
    this.connected = false;
    this.pcm16 = Buffer.alloc(0);
  }
}

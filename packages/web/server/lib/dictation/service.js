import path from 'path';

import { readVoiceKey } from '../tts/voice-keys.js';
import { detectTextLanguage } from '../tts/language-detect.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
/**
 * Dictation service: resolves STT providers, tracks local model download
 * state, and exposes a readiness snapshot for the status route.
 *
 * Providers:
 * - 'local' (default): sherpa-onnx Parakeet running in a worker process.
 *   Models auto-download in the background on first use.
 * - 'openai-compatible': any OpenAI-compatible /v1/audio/transcriptions
 *   endpoint (faster-whisper, whisper.cpp, OpenAI).
 * - 'elevenlabs': ElevenLabs Scribe, with an installed local model taking
 *   over segments the cloud fails on.
 */

import { rm } from 'fs/promises';

import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './local/worker-client.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import { ElevenLabsTranscriptionSession } from './elevenlabs-session.js';
import { createDictationUsageStore } from './usage-store.js';
import { toSpeechLanguageCode } from './language.js';
import {
  DEFAULT_LOCAL_TTS_MODEL,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_STT_MODEL_IDS,
  LOCAL_TTS_MODEL_CATALOG,
  LOCAL_TTS_MODEL_IDS,
  getLocalSttModelDir,
  isLocalModelId,
  isLocalTtsModelId,
  resolveLocalSttModelId,
} from './local/model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './local/model-downloader.js';

const resolveProvider = (provider) =>
  provider === 'openai-compatible' || provider === 'elevenlabs' ? provider : 'local';

/**
 * @param {{ modelsDir: string, usageFilePath?: string, fetchImpl?: typeof fetch }} options
 */
export function createDictationService({
  modelsDir,
  usageFilePath = path.join(path.dirname(modelsDir), 'dictation-usage.json'),
  fetchImpl = fetch,
}) {
  const workerClient = new DictationWorkerClient();
  const usageStore = createDictationUsageStore({ filePath: usageFilePath });
  /** modelId -> 'downloading' | 'error' */
  const downloadStates = new Map();
  /** modelId -> last download error message */
  const downloadErrors = new Map();
  /** modelId -> in-flight ensure promise */
  const downloadPromises = new Map();
  /** modelId -> 0..100 download percent (null while size unknown) */
  const downloadProgress = new Map();

  const startModelDownload = (modelId) => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    downloadProgress.set(modelId, 0);
    const promise = ensureLocalSttModel({
      modelsDir,
      modelId,
      onProgress: (downloadedBytes, totalBytes) => {
        downloadProgress.set(
          modelId,
          totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
        );
      },
    })
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      })
      .catch((error) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, error?.message || String(error));
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  /**
   * @param {Buffer} pcm16
   * @param {{ localModel?: string, language?: string }} options
   * @returns {Promise<string | null>}
   */
  const transcribeLocally = async (pcm16, options) => {
    const languageCode = toSpeechLanguageCode(options.language);
    const candidates = [resolveLocalSttModelId(options.localModel, languageCode), ...LOCAL_STT_MODEL_IDS];
    let modelId = null;
    for (const candidate of candidates) {
      if (await isLocalSttModelInstalled(modelsDir, candidate)) {
        modelId = candidate;
        break;
      }
    }
    if (!modelId) {
      return null;
    }
    const session = new WorkerBackedTranscriptionSession(workerClient, { modelsDir, modelId, language: languageCode });
    await session.connect();
    try {
      return await new Promise((resolve, reject) => {
        session.once('transcript', ({ transcript }) => resolve(transcript));
        session.once('error', reject);
        session.appendPcm16(pcm16);
        session.commit();
      });
    } finally {
      session.close();
    }
  };

  /**
   * Create a connected StreamingTranscriptionSession for one dictation.
   * Returns { session } on success or { error, retryable, reasonCode } when
   * the provider is not ready.
   *
   * @param {{ provider?: string, language?: string, localModel?: string, vocabulary?: string[],
   *           openaiCompatible?: { baseUrl?: string, model?: string, apiKey?: string } }} options
   */
  const createSttSession = async (options = {}) => {
    const provider = resolveProvider(options.provider);
    const languageCode = toSpeechLanguageCode(options.language);

    if (provider === 'elevenlabs') {
      const session = new ElevenLabsTranscriptionSession({
        apiKey: readVoiceKey('elevenlabs'),
        language: options.language,
        keyterms: options.vocabulary,
        fetchImpl,
        transcribeFallback: (pcm16) => transcribeLocally(pcm16, options),
        recordUsage: (seconds) => usageStore.addCloudSeconds('elevenlabs', seconds),
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: error?.message || String(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    if (provider === 'openai-compatible') {
      const config = options.openaiCompatible || {};
      const session = new OpenAICompatibleTranscriptionSession({
        baseURL: config.baseUrl,
        model: config.model,
        // The key stored in Settings; one sent with the request comes from a
        // client older than the server-side store.
        apiKey: config.apiKey || readVoiceKey('stt'),
        language: options.language || undefined,
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: error?.message || String(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    const modelId = resolveLocalSttModelId(options.localModel, languageCode);
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        // Allow a retry on the next attempt.
        downloadStates.delete(modelId);
        return {
          error: `Failed to download dictation model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const session = new WorkerBackedTranscriptionSession(workerClient, { modelsDir, modelId, language: languageCode });
    try {
      await session.connect();
    } catch (error) {
      const message = error?.message || String(error);
      // A model that passes the file-presence check but fails to load is
      // corrupt on disk (e.g. truncated by an interrupted extraction). Remove
      // it so the next attempt re-downloads instead of crashing forever.
      if (/Load model|Protobuf parsing failed/i.test(message)) {
        await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true })
          .catch(() => undefined);
        return {
          error: 'Dictation model files were corrupt and have been removed; retry to re-download',
          retryable: true,
          reasonCode: 'model_corrupt',
        };
      }
      return {
        error: message,
        retryable: true,
        reasonCode: 'stt_unavailable',
      };
    }
    return { session };
  };

  /**
   * Readiness snapshot for the status route and UI gating.
   * @param {{ provider?: string, localModel?: string, language?: string }} [options]
   */
  const getStatus = async (options = {}) => {
    const provider = resolveProvider(options.provider);
    const modelId = resolveLocalSttModelId(options.localModel, toSpeechLanguageCode(options.language));
    const cloudUsage = usageStore.readCurrentMonth();

    const describeModel = async (id, catalog) => ({
      id,
      description: catalog[id].description,
      installed: await isLocalSttModelInstalled(modelsDir, id),
      downloading: downloadStates.get(id) === 'downloading',
      downloadProgress: downloadProgress.get(id) ?? null,
      downloadError: downloadErrors.get(id) || null,
    });

    const models = await Promise.all(
      LOCAL_STT_MODEL_IDS.map((id) => describeModel(id, LOCAL_STT_MODEL_CATALOG)),
    );
    const ttsModels = await Promise.all(
      LOCAL_TTS_MODEL_IDS.map((id) => describeModel(id, LOCAL_TTS_MODEL_CATALOG)),
    );

    if (provider === 'openai-compatible') {
      return { provider, available: true, models, ttsModels, cloudUsage };
    }

    if (provider === 'elevenlabs') {
      if (isEnterpriseMode()) {
        return { provider, available: false, reasonCode: 'enterprise_mode', models, ttsModels, cloudUsage };
      }
      if (!readVoiceKey('elevenlabs')) {
        return { provider, available: false, reasonCode: 'stt_not_configured', models, ttsModels, cloudUsage };
      }
      return { provider, available: true, models, ttsModels, cloudUsage };
    }

    const model = models.find((entry) => entry.id === modelId) || null;
    if (model?.installed) {
      return { provider, available: true, activeModel: modelId, models, ttsModels, cloudUsage };
    }
    if (model?.downloading) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_in_progress',
        activeModel: modelId,
        models,
        ttsModels,
        cloudUsage,
      };
    }
    if (model?.downloadError) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_failed',
        error: model.downloadError,
        activeModel: modelId,
        models,
        ttsModels,
        cloudUsage,
      };
    }
    return {
      provider,
      available: false,
      reasonCode: 'models_missing',
      activeModel: modelId,
      models,
      ttsModels,
      cloudUsage,
    };
  };

  /**
   * Synthesize speech with the local TTS model. Returns WAV bytes, or a
   * readiness error while the model is missing/downloading.
   *
   * With `language: 'auto'` the text's language decides the model: the
   * caller's model when it speaks that language, otherwise the catalog
   * model for it (downloaded on first use, reported as in-progress until it
   * lands). The caller's speaker id is kept only on the caller's model; a
   * substitute model starts from its own default speaker for the language.
   * A language no catalog model covers keeps the caller's model, so text is
   * never silently dropped.
   * `languageSample` is the whole message the chunk belongs to (or a prefix
   * of it): the language is judged on that, never on a short chunk alone.
   * @param {{ text: string, model?: string, speakerId?: number, speed?: number, language?: string, languageSample?: string }} options
   */
  const synthesizeSpeech = async ({ text, model, speakerId, speed, language, languageSample }) => {
    const requestedModelId = isLocalTtsModelId(model) ? model : DEFAULT_LOCAL_TTS_MODEL;
    let modelId = requestedModelId;
    let resolvedLanguage = null;
    if (language === 'auto') {
      resolvedLanguage = detectTextLanguage(languageSample || text).language;
      const forLanguage = resolveLocalTtsModelForLanguage(resolvedLanguage, requestedModelId);
      if (forLanguage && forLanguage !== requestedModelId) {
        modelId = forLanguage;
        speakerId = getLocalTtsDefaultSpeaker(modelId, resolvedLanguage);
      }
    }
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download TTS model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'TTS model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const result = await workerClient.synthesizeSpeech({
      modelsDir,
      modelId,
      text,
      speakerId,
      speed,
    });
    return { audio: result.audio, format: result.format, modelId, language: resolvedLanguage };
  };

  /**
   * Kick off a background download for a model (used by the status route's
   * download action so Settings can pre-download models).
   */
  const requestModelDownload = async (modelId) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (await isLocalSttModelInstalled(modelsDir, modelId)) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  /**
   * Delete an installed model from disk. A model that is mid-download cannot
   * be deleted. An engine already loaded in the worker keeps its in-memory
   * copy until the worker's idle shutdown; the files are simply re-downloaded
   * on the next use if the model is selected again.
   */
  const deleteModel = async (modelId) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (downloadStates.get(modelId) === 'downloading') {
      return { ok: false, error: 'Model is downloading' };
    }
    await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    downloadErrors.delete(modelId);
    return { ok: true };
  };

  const shutdown = () => {
    workerClient.shutdown();
  };

  return {
    createSttSession,
    synthesizeSpeech,
    getStatus,
    requestModelDownload,
    deleteModel,
    shutdown,
  };
}

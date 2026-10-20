# Dictation module

Server-authoritative speech-to-text for the chat composer, plus local
text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64) over a
WebSocket while the user speaks; the server buffers them and transcribes each
segment exactly once, when the segment is committed.

Transcription is deliberately not incremental. Parakeet is an offline model
trained on whole utterances, so re-decoding the growing buffer to animate a
live transcript costs O(n^2) work for a result the final decode replaces. The
composer shows no text while recording and inserts the full transcript on
stop.

Local TTS (Kokoro and Piper/VITS via sherpa-onnx OfflineTts) runs in the same
worker process and is exposed as `POST /api/dictation/tts/speak` (JSON
`{text, speakerId?, speed?, model?, language?, languageSample?}` → WAV bytes; 503 with
`reasonCode` while the model is downloading). TTS models live in the same
catalog/downloader as STT models (`local/model-catalog.js`
`LOCAL_TTS_MODEL_CATALOG`) and are managed by the same status/download/delete
routes.

Each TTS catalog entry declares the `languages` it speaks. With
`language: 'auto'` the service detects the language of `languageSample` — the
whole message the chunk belongs to, sent by the client with every chunk — or
of `text` when no sample is given
(`../tts/language-detect.js`, script plus function-word scoring, no
dependencies) and keeps the caller's model when it speaks that language;
otherwise it switches to the catalog model for the language, downloading it on
first use like any other model, and starts from that model's default speaker
(`defaultSpeakerByLanguage`) instead of the caller's speaker id. A language no
catalog model covers keeps the caller's model, so text is always spoken. The
response carries `X-Speech-Model` and `X-Speech-Language`.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate, segment
  splitting inside pauses, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx Parakeet TDT in a forked worker process.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`). `connect()`
    runs the same URL check as every transcription
    (`normalizeCustomOpenAIBaseURL`), so a refused host — any remote one in
    enterprise mode — fails before the user dictates.
  - `elevenlabs`: ElevenLabs Scribe (`elevenlabs-session.js`), see
    [ElevenLabs](#elevenlabs).
- `usage-store.js` — seconds of audio ElevenLabs transcribed, per calendar
  month (server local time), in `dictation-usage.json` beside
  `speech-models` in the data dir. Segments that fell back to the local
  model do not count.
- `language.js` — language codes: the primary subtag for cloud providers,
  and the Whisper-known subset for local Whisper models.
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and segment session (one decode per committed segment),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `audio.js` — PCM16 helpers: format parsing, peak, per-frame RMS, WAV
  wrapping, streaming linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`notice {reasonCode}` is informational and never ends the dictation. Today
it is sent once per dictation with `stt_cloud_fallback_local` when a cloud
segment fell back to the local model; the composer shows it as a toast.
Clients that do not know the frame ignore it.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible' | 'elevenlabs', language?,
localModel?, vocabulary?, openaiCompatible?: { baseUrl, model, apiKey } }`.
No key travels in `options` for ElevenLabs: the server reads it from
`voice-keys.json` (`../tts/voice-keys.js`). `vocabulary` is the profile
setting `sttVocabulary`, shared by every server the person uses.

`GET /api/dictation/status` takes `provider`, `localModel` and `language`
and always answers `cloudUsage: { month, elevenlabsSeconds }` for the cost
line in Settings. For `elevenlabs` it answers `available: false` with
`reasonCode: 'stt_not_configured'` (no key) or `'enterprise_mode'`.

## Local model choice

The client sends the model the person picked. When none is picked
(`sttLocalModel` empty, `packages/ui/src/lib/dictation/stt-preferences.ts`)
the model follows the language: Whisper large-v3 turbo
(`whisper-turbo-int8`) when the dictation language is Turkish, or automatic
on a Turkish interface, and Parakeet v2 (English) otherwise. Parakeet v2 is
English-only and v3 has no Turkish. The server applies the same rule for a
missing model id with `language: 'tr'` (`resolveLocalSttModelId`).

Whisper models get the dictation language (`tr`, `en`, ...) or detect it
when it is blank or `auto`. A code Whisper does not know is sent as auto:
sherpa-onnx ends the worker process on an unknown language
(`Invalid language: xx`, exit 255). The worker keeps one engine per model
and language.

Whisper in sherpa-onnx takes no initial prompt and no hotwords (its config
is `encoder/decoder/language/task/tailPaddings`; hotwords need a transducer
with `modified_beam_search`, Whisper is greedy only), so the vocabulary list
reaches ElevenLabs only.

Turbo (`sherpa-onnx-whisper-turbo.tar.bz2`, 564 MB download, 1.0 GB on
disk: `turbo-encoder.int8.onnx`, `turbo-decoder.int8.onnx`,
`turbo-tokens.txt`) measured on an Apple M4 (10 cores) with 2 threads, on a 14.7 s
Turkish clip with English terms, while the machine was under heavy
unrelated load (load average ~45 on 10 cores, an Android emulator running):
model load 10.6–13.1 s, decode 34–41 s, peak RSS 1.7–2.1 GB. Whisper base
under the same load: 4.5 s load, 14–16 s decode, 0.76 GB. These numbers are
inflated by the load and only the ratio (turbo ≈ 2.5× base) carries over;
an idle measurement is still to be done. Turbo's transcript kept "deploy",
"test", "restart", "timeout", "pull request" and the Turkish grammar; base
garbled most of them. Turbo still misheard project names ("zone" → "Zohan",
"Pi5" → "P5"), which the vocabulary fixes only on ElevenLabs.

## ElevenLabs

Each committed segment is one `POST https://api.elevenlabs.io/v1/speech-to-text`
(multipart: `model_id=scribe_v2`, `file` = WAV of the segment,
`tag_audio_events=false`, `language_code` only when a language is set, one
`keyterms` field per vocabulary term). The key goes only in the
`xi-api-key` header; error messages carry the HTTP status and Scribe's
`detail.status` word, never the response body. Keyterms are trimmed,
deduplicated, kept under 50 characters and 5 words without `<>{}[]\`, and
capped at 100 (over 100 adds a 20 s minimum billable duration per request).

Failures map to `error {reasonCode}`: 401/403 → `stt_not_configured`,
402/429 → `stt_quota_exceeded`, anything else (network, timeout after 20 s,
5xx, a body without `text`) → `stt_unavailable`. Before an error reaches the
client, the segment is transcribed by an installed local model (the
dictation's resolved local model first, then any installed one); the first
fallback of a dictation sends `notice {reasonCode: 'stt_cloud_fallback_local'}`.
With no local model installed, the cloud error ends the dictation as before.

Cost shown in Settings is an estimate: about $0.22 per hour of audio on the
API, about 330 credits per minute on a subscription, +20 % with keyterms.
The server counts only what it sent; it cannot read the account's plan.

ElevenLabs is egress in enterprise-mode terms: `connect()` refuses it in
enterprise mode, before any audio is sent, and the status route reports
`enterprise_mode`.

## Segmentation

A dictation is one segment unless it runs long. Past `segmentMinSeconds`
(15 s) the manager cuts inside the first pause it finds, so cuts land between
words; `segmentMaxSeconds` (25 s) is a hard cap for speech with no pause in it.

Pauses are found inside each ~1 s client chunk, not at chunk boundaries: the
chunk is scored in 50 ms RMS frames; a frame is quiet when it is close to the
stream's noise floor (the quietest frame in the last ~10 s, so a fan or a
boosted mic does not hide every pause and a silent first second from a gated
mic is soon forgotten) and well below its loudest frame (so soft speech does
not pass for a pause), a pause is a quiet run of at least 200 ms, and the cut
goes into the middle of that run — a pause that straddles two chunks still
counts, cut at the chunk boundary when its middle already went by. At the
hard cap the cut goes into the quietest frame of the chunk that crosses it.
Bytes before the cut end the committed segment, bytes after it start the next
one; the client's `seq` and ack are untouched because the whole chunk is
consumed either way.

The bounds exist because Parakeet is a full-attention conformer: decode cost
and peak memory grow quadratically with segment length. Measured on Parakeet
v3 int8 with 2 threads: 15 s ≈ 0.6 s, 60 s ≈ 2.9 s / 1.17 GB, 90 s ≈ 4.9 s /
1.60 GB, and a single ~165 s+ segment aborts the worker (native `onnxruntime`
`SIGTRAP` in `BFCArena::Extend`). Short segments keep a long dictation far from
that cliff: 24 × 25 s stayed flat at ~1.17 GB. Committed segments decode while
the user is still speaking, so only the tail is left to transcribe on stop.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- Transcription happens on commit only; sessions never emit non-final
  transcripts. The `partial` messages a client receives are the concatenation
  of already-committed segments, and exist so a dictation that fails partway
  can be salvaged instead of losing minutes of speech.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- A cloud provider's key never appears in a frame, a status answer or a log
  line.
- Model files live under `~/.config/openchamber/speech-models`.

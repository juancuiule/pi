# Dictation with live transcription: research

Researched 2026-11-03 for the composer's mic button ([#55](https://github.com/juancuiule/pi/issues/55)). #55 designs a batch upload after stop over `POST /v1/audio/transcriptions`; this note compares that with ways to show text while the person is still speaking. Prices and model names move fast: each claim links the page it came from, read on that date.

## Recommendation

**v1: a server-relayed dictation socket with pseudo-streaming over any OpenAI-compatible `/v1/audio/transcriptions` endpoint.**

- The browser captures the microphone with an `AudioWorklet`, downsamples to 16 kHz mono PCM16 and streams it over a WebSocket to the server (`GET /api/dictation`). The server never exposes a provider key and is the only thing that talks to the speech service, the same shape as web search (the server only ever talks to SearXNG).
- The server cuts the audio into segments at pauses (a simple energy VAD on the PCM, plus a cap of ~20 s per segment). About once a second, while no request is in flight, it re-transcribes the open segment and sends `interim` text; when a pause closes the segment it transcribes it once more and sends `final` text. Each request is a WAV built in memory from the PCM, so no ffmpeg and no container quirks.
- The backend stays #55's: one base URL, key and model. That covers Groq `whisper-large-v3-turbo` (fast, $0.04/h), a self-hosted Speaches (faster-whisper, on CPU or on this host's GTX 1070 Ti), and OpenAI `gpt-transcribe`, with nothing vendor-specific in the code.
- Recommended default backend: **Groq** for quality and speed without a GPU, or **Speaches on the GPU box** when audio must stay on the LAN. On a CPU-only host, Speaches with `small`/`base` int8 works but partials arrive every 1.5-3 s instead of every ~1 s (see measurements below).

**Fallback (same socket, same UI): final-only mode.** When the backend is too slow or too costly for partials (CPU-only Speaches with a large model, a Groq budget), the server skips interim requests and sends `final` per segment at each pause. The person still sees text appear phrase by phrase while speaking, just a sentence late. This also degrades gracefully to #55's behaviour (everything on stop) when the segmenter never sees a pause.

**v2, when wanted: a `realtime` engine behind the same socket.** The OpenAI Realtime transcription protocol (`wss://…/v1/realtime?intent=transcription`) is becoming the second de facto standard: OpenAI `gpt-live-transcribe`, vLLM serving Voxtral Realtime, and Speaches all speak it. The server would relay PCM to it instead of chunking. It gives word-by-word partials but needs either a paid API ($0.017/min at OpenAI) or a ≥16 GB GPU (Voxtral), neither of which the current host has.

Why not the browser-only options for v1: the Web Speech API sends audio to Google (Chrome) or Apple by default and its on-device mode is desktop-only; in-browser models (Moonshine, Whisper on WebGPU) are private and free but monolingual or heavy, untested on phones, and put a 100+ MB download in the console. Both are worth a spike, not a v1 (details below).

## How the options compare

| Option | Partial text | Spanish + English | Cost | Without a GPU | Audio leaves the host | Fit / complexity |
| --- | --- | --- | --- | --- | --- | --- |
| **Pseudo-streaming over `/v1/audio/transcriptions`** (recommended) | every ~1 s (Groq, GPU) to 1.5-3 s (CPU) | Whisper: good; language hint per session | Groq ≈ $0.007/min with 1 s partials, $0.0007/min final-only; self-hosted free | yes (Speaches CPU) | Groq/OpenAI: yes. Speaches: no | one socket, one segmenter, no new protocol; works with every backend in #55 |
| Batch after stop (#55 as written) | none | same | cheapest | yes | same | simplest; no live text |
| OpenAI Realtime, `gpt-live-transcribe` | word-by-word, "tunable latency" | multilingual with language hints | $0.017/min | n/a (cloud) | yes, to OpenAI | relay PCM over a second socket; client-side VAD must commit turns |
| Voxtral Realtime (open weights, vLLM) | 80 ms-2.4 s delay, 480 ms recommended | 13 languages incl. es; FLEURS es WER 3.31 % | free self-hosted; API $0.006/min | no: one GPU ≥16 GB | no (self-hosted) | same Realtime relay; the GTX 1070 Ti (8 GB) is too small |
| Speaches Realtime | per utterance (after VAD silence), not word-by-word | Whisper | free | yes | no | same Realtime relay, but no better than our own chunking |
| Deepgram Nova-3 / Flux streaming | interim + final, endpointing | Nova-3 `es`, `es-419`; Flux multi incl. es | $0.0077-0.0092/min, $200 free credit | n/a | yes | proprietary WS protocol; one more engine |
| AssemblyAI Universal-Streaming | `Turn` partials | multilingual model; Spanish listed for streaming medical mode, full list unconfirmed | $0.15/h (multilingual), billed while the socket is open | n/a | yes | proprietary WS; idle time billed |
| Mistral Voxtral API | realtime model via API | 13 languages | $0.006/min realtime, $0.003/min batch | n/a | yes | batch is OpenAI-shaped; realtime wire protocol not checked |
| WhisperLive (Collabora) | partial + committed segments | Whisper | free | CPU image exists | no | own WS protocol, a Python server to run |
| SimulStreaming / whisper_streaming (ÚFAL) | yes | Whisper | free | "too slow for real-time" on CPU | no | raw TCP + JSONL; research code |
| Kyutai STT | 0.5 s delay (1B) | **en/fr only** | free | GPU (Rust server) or Apple MLX | no | out: no Spanish |
| NVIDIA Parakeet TDT 0.6B v3 | chunked (NeMo script) | 25 European languages incl. es; FLEURS es 3.45 % | free | runs on CPU, tuned for NVIDIA | no | NeMo or Speaches' Parakeet executor; no live server of its own |
| Moonshine v2 streaming (browser or server) | streaming, ~165 ms/update on x86 (vendor) | **monolingual models**: Spanish small 4.9 %, tiny 6.2 % (MIT) | free | yes, even a Raspberry Pi 5 | no (in-browser) | pick one language per session; no OpenAI-compatible server |
| transformers.js Whisper on WebGPU | re-transcribe loop in a worker | Whisper base: weak on Spanish | free | needs WebGPU on the device | no | big download, phone support unknown |
| Web Speech API | interim results, native | `es-AR`, `en-US` | free | yes | **yes, by default** (Google/Apple); on-device only Chrome/Firefox desktop | smallest code, least control |

## Findings by option

### OpenAI-compatible batch endpoints (the #55 backend)

- OpenAI now recommends `gpt-transcribe` ($0.0045/min); `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` are deprecated and shut down on 2027-02-26. `gpt-transcribe` accepts a `languages` list and supports `stream=true`, which streams the _text_ of a completed file as `transcript.text.delta` events, not live audio. Files up to 25 MB; webm, wav, mp4/m4a, mp3 accepted. ([speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text), [pricing](https://developers.openai.com/api/docs/pricing))
  - So a #55 config pointing at `whisper-1` would break in February 2027; the default model name must not be hard-coded to it.
- Groq serves `whisper-large-v3-turbo` at $0.04/h and `whisper-large-v3` at $0.111/h on `https://api.groq.com/openai/v1/audio/transcriptions`; **every request is billed at least 10 s**, uploads up to 25 MB (free tier). No streaming. ([Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text))
  - With 1 s partials, a minute of speech is ~60 requests × 10 s billed ≈ 10 billed minutes ≈ $0.0067/min. Final-only is ~$0.0007/min.
- Speaches (formerly faster-whisper-server) is OpenAI API-compatible, runs on CPU or GPU in Docker, streams transcripts of a file over SSE, and has a Realtime API. Last release `v0.9.0-rc.3` (2025-12-27), commits through 2026-04. It now also has a Parakeet executor beside faster-whisper. ([README](https://github.com/speaches-ai/speaches), [releases](https://github.com/speaches-ai/speaches/releases), [`src/speaches/executors/`](https://github.com/speaches-ai/speaches/tree/master/src/speaches/executors))
- CPU speed (faster-whisper's own benchmark, 13 min of audio, `small`, i7-12700K, 8 threads): int8 1m42s, fp32 2m37s, i.e. ~8× real time. On an RTX 3070 Ti, `large-v2` fp16 took 1m03s. ([faster-whisper README](https://github.com/SYSTRAN/faster-whisper))
  - Whisper always encodes a 30 s window, so a 3 s chunk costs about as much as a 30 s one: on CPU, ~1-2 s per `small` request whatever the chunk length. That sets the CPU partial cadence. This host's i7-8700K (6 cores/12 threads) is slower than the benchmark's 12700K.

### True streaming services

- **OpenAI Realtime transcription**: connect to `wss://api.openai.com/v1/realtime?intent=transcription`, `session.update` with `type: "transcription"` and `gpt-live-transcribe`, send `input_audio_buffer.append` with PCM (examples use 24 kHz PCM16), get `…input_audio_transcription.delta` partials and `…completed` finals. `gpt-live-transcribe` has no server VAD: "Use client-side VAD to detect the end of speech, then send `input_audio_buffer.commit`." Browsers are meant to use WebRTC with an ephemeral client secret minted by the server (`/v1/realtime/client_secrets`). $0.017/min. ([realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription), [model page](https://developers.openai.com/api/docs/models/gpt-live-transcribe.md), [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc.md), [pricing](https://developers.openai.com/api/docs/pricing))
- **Voxtral Realtime** (Mistral, Feb 2026): open weights `Voxtral-Mini-4B-Realtime-2602`, Apache 2.0, 13 languages including Spanish; delay configurable 80 ms-2.4 s, 480 ms recommended; FLEURS Spanish WER 3.31 % at 480 ms. Needs "a single GPU with >= 16GB memory", served by vLLM at `/v1/realtime` over WebSocket. Mistral's API charges $0.006/min realtime, $0.003/min batch. ([model card](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [announcement](https://mistral.ai/news/voxtral-transcribe-2))
- **Deepgram**: Nova-3 streams Spanish (`es`, `es-419`); Flux `flux-general-multi` includes `es`. Interim results with `is_final`/`speech_final` and endpointing. Streaming $0.0077/min (monolingual) to $0.0092/min (multilingual), $200 free credit. ([models](https://developers.deepgram.com/docs/models-languages-overview), [live audio](https://developers.deepgram.com/docs/live-streaming-audio), [pricing](https://deepgram.com/pricing))
- **AssemblyAI** Universal-Streaming: repeated `Turn` messages, `end_of_turn: true` on finals; PCM16, AAC or Opus input; browser use through temporary tokens. Multilingual streaming $0.15/h, **billed from socket open to close**. Spanish appears in the docs only for the medical mode list; the full streaming language list was not confirmed. ([streaming docs](https://www.assemblyai.com/docs/speech-to-text/universal-streaming), [pricing](https://www.assemblyai.com/pricing))
- **Speaches Realtime**: supports `intent=transcription`, but its code transcribes a turn when Silero VAD reports speech stopped (`commit_and_transcribe` in [`input_audio_buffer_event_router.py`](https://github.com/speaches-ai/speaches/blob/master/src/speaches/realtime/input_audio_buffer_event_router.py)), so partials are per utterance, and the docs say real-time use needs CUDA. ([realtime docs](https://speaches.ai/usage/realtime-api/))

### Self-hosted streaming models

- **WhisperLive**: WebSocket server with faster-whisper, TensorRT or OpenVINO backends; a CPU Docker image (`ghcr.io/collabora/whisperlive-cpu`); segments carry a `completed` flag (partial vs committed). Browser clients are extensions, not a library. ([README](https://github.com/collabora/WhisperLive))
- **SimulStreaming** (successor of whisper_streaming, MIT): ~5× faster than whisper_streaming, but "works also on CPU but would be too slow for real-time"; recommends a ≥10 GB GPU for large-v3. ([README](https://github.com/ufal/SimulStreaming))
- **Kyutai STT**: 1B model is English/French with 0.5 s delay, 2.6B English only. No Spanish. ([delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling))
- **Parakeet TDT 0.6B v3**: 25 European languages with auto-detection, Spanish WER 3.45 % (FLEURS), CC-BY-4.0, streaming via NeMo's chunked script, ≥2 GB RAM, optimized for NVIDIA. ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3))
- **Moonshine v2**: streaming models trained from scratch, MIT; **Spanish Small Streaming (123M) 4.9 % WER, Tiny Streaming (34M) 6.2 %** on a FLEURS+MLS sample; one library for Python, JS/WASM (`@moonshine-ai/moonshine-wasm`, `MicTranscriber` with `onText` partials and `onLine` finals), Raspberry Pi. Vendor latency per update for Small Streaming: 73 ms (MacBook Pro), 165 ms (Linux x86), 527 ms (Raspberry Pi 5), versus seconds for Whisper Small. Models are one language each: no code-switching. ([README](https://github.com/moonshine-ai/moonshine), [models](https://moonshine-voice.readthedocs.io/en/latest/models/available-models/), [accuracy](https://moonshine-voice.readthedocs.io/en/latest/models/accuracy/), [quickstart](https://moonshine-voice.readthedocs.io/en/latest/quickstart/), [paper arXiv:2602.12241](https://arxiv.org/abs/2602.12241); the latency table is the vendor's, mirrored at [this README](https://github.com/thinhlpg/moonshine), not independently checked)

### In the browser

- **Web Speech API**: "By default … your audio is sent to a web service for recognition processing." On-device recognition (`processLocally = true`, `SpeechRecognition.available()` / `install()` of a language pack) exists in Chrome 139+ and Firefox 160+ desktop, not in Chrome Android or Safari. Safari has `webkitSpeechRecognition` since 14.1 (prefixed). `interimResults` gives live partials. ([MDN guide](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API), [browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json))
  - Smallest implementation and real live text, but on phones audio goes to Google or Apple whatever the server's configuration, the app cannot pick or test the engine, and accuracy differs per browser. A reasonable "zero-config" mode only if the person accepts that.
- **transformers.js**: the official `realtime-whisper-webgpu` example loads `onnx-community/whisper-base` on WebGPU and re-runs generation in a worker; `moonshine-web` runs Moonshine Base with Silero VAD on WebGPU or WASM. Whisper base is weak on Spanish and the Moonshine example is English. ([examples](https://github.com/huggingface/transformers.js-examples), [`realtime-whisper-webgpu/src/worker.js`](https://github.com/huggingface/transformers.js-examples/blob/main/realtime-whisper-webgpu/src/worker.js), [`moonshine-web/src/worker.js`](https://github.com/huggingface/transformers.js-examples/blob/main/moonshine-web/src/worker.js))
  - Moonshine's own WASM package with the Spanish streaming model is the interesting private, zero-cost path; its download size and phone performance are unmeasured.

## Fit with this app

- **The socket**: `next.config.ts`'s `/api` rewrite cannot carry WebSockets, so the client connects to the server's port the way `shellUrl` does (`serverSocketUrl` in `web/lib/shell.ts`), and `deploy/Caddyfile`'s `@sockets` matcher (`^/api/conversations/[^/]+/(shell|desktop)$`) needs `/api/dictation` added. `loopbackOnly` already guards every route.
- **Auth**: dictation is per User, not per Conversation (the New conversation composer has none yet), so the route checks the session only: `Auth.authenticate` on the cookie, the first half of `authorize` in `src/server/auth.ts`, not `seatForSocket`. Keeping the path outside `conversations/:id` means `isolation.test.ts`'s ownership sweep does not apply; a test for 401 without a session is needed by hand.
- **Why PCM over the socket and not `MediaRecorder` chunks**: a `MediaRecorder` timeslice chunk after the first has no container header, so it cannot be transcribed on its own, and Safari only gained WebM/Opus recording in 18.4 (before that it produced MP4). PCM from an `AudioWorklet` (Chrome 66, Safari/iOS 14.1, Firefox 76) is the same everywhere, lets the server run VAD, and is 32 KB/s at 16 kHz, trivial for a LAN or tunnel. ([WebKit 18.4 notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [browser-compat-data AudioWorkletNode](https://github.com/mdn/browser-compat-data/blob/main/api/AudioWorkletNode.json))
- **Secure context**: `navigator.mediaDevices` is `undefined` outside HTTPS or localhost. ([MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)) The `lan` exposure is plain `http://<LAN IP>` (`docs/deploy/exposure.md`), so **the mic cannot work there**; it works on localhost, Tailscale serve (https) and the Cloudflare tunnel. The button must say so instead of failing silently.
- **Mobile**: iOS starts `AudioContext` suspended until a user gesture and runs it at the hardware rate (usually 48 kHz), so the worklet resamples; capture stops when the screen locks or the tab is backgrounded, which the client reports as an interrupted dictation, keeping the text so far.
- **Load**: like `WEB_SEARCH_CONCURRENCY`, a semaphore caps simultaneous transcription requests across sessions, and at most one interim request per session is in flight (a new partial waits for the previous answer, so a slow backend lowers the cadence instead of queueing).
- **Tracing**: a span per dictation session with duration, segments, requests and the backend's latency, never the audio or, unless asked (cf. `TRACE_ATTACHMENT_TEXT`), the text.

### Wire protocol sketch

```
client → server   {"type":"start","language":"es"|"en"|null}     first text frame
client → server   <binary PCM16 LE, 16 kHz mono, ~100 ms frames>
client → server   {"type":"stop"} | {"type":"cancel"}
server → client   {"type":"interim","segment":3,"text":"y después vamos a"}
server → client   {"type":"final","segment":3,"text":"Y después vamos a revisar el deploy."}
server → client   {"type":"error","reason":"backend_unavailable"|"too_long"|...}
server → client   {"type":"done"}                                  after stop, once every segment is final
```

A `final` replaces that segment's interim text. `cancel` drops everything; `stop` flushes the open segment.

## UX sketch

References: Apple's dictation (inline text, a mic glyph at the caret, uncertain words underlined), Google Docs voice typing (interim text gray, then black), ChatGPT's composer dictation (the input becomes a live waveform with cancel and confirm, text appears after confirm), Wispr Flow and Superwhisper (a global hold-to-talk hotkey and a small floating pill with a level meter).

- **Where text goes**: the composer's textarea cannot style part of its text, so finalized segments are inserted into the textarea at the caret position captured when dictation started (keeping the person's edits elsewhere), and the interim tail is shown in a **live strip** just above the textarea: muted, italic, with a blinking caret. When a segment finalizes, its text moves from the strip into the textarea. The person can keep typing while speaking; insertion follows the caret's anchor, not the end.
  - The richer alternative, interim text drawn inline through a mirror overlay of the textarea, gets brittle with autosize, scrolling and the `/skill:` and `@` autocomplete; not for v1.
- **Mic button states** (beside Send): idle (mic icon) → requesting permission (spinner, "Allow the microphone") → listening (red dot, live level meter in the button, `0:12` timer) → finishing (spinner while the last segment transcribes) → idle. Click toggles; the strip shows **Cancel** (Esc) and **Done** (click again or Mod+Shift+Space).
- **Level meter / waveform**: an `AnalyserNode` RMS drawn as 3-5 bars in the button or a thin scrolling waveform in the strip. It proves the mic is hearing something before any text exists; "No sound from the microphone" after ~3 s of silence at the start.
- **Language**: a small toggle in the strip (Auto / ES / EN), remembered per browser. Whisper's auto-detection decides once per request, so mixed Spanish and English sentences come out better with a fixed choice.
- **Limits**: a timer warning 30 s before `TRANSCRIBE_MAX_SECONDS`, then an automatic stop that keeps the text.
- **Errors** (inline in the strip, text kept, never a toast that hides the draft): permission denied ("Microphone blocked: allow it in the site settings"), insecure context ("Dictation needs https or localhost"), no device, backend down or rate-limited ("Transcription unavailable; what you said so far is kept"), socket dropped mid-dictation.
- **Keyboard**: Mod+Shift+Space toggles (Mod+K is search; Ctrl+Space switches input sources on macOS), Esc cancels while listening. Later: hold-to-talk on the same chord.
- **Accessibility**: the button is a toggle with `aria-pressed` and a label that changes ("Start dictation" / "Stop dictation"); the strip is not a live region for interim text (it would chatter), but each finalized segment is announced politely through the composer's existing `aria-live="polite"` span; the level meter is `aria-hidden`; focus stays in the textarea; `prefers-reduced-motion` freezes the meter and caret blink.
- **Unconfigured**: no mic button at all when no backend is set, read from `GET /api/info` (the `transcribe: boolean` #55 proposes).

## Configuration it would need

Mirroring `.env.schema` (`MODEL_*`, `OLLAMA_URL`, `WEB_SEARCH_*`) and keeping #55's prefix:

```
# --- Dictation (src/transcribe/): the composer's mic; unset TRANSCRIBE_URL, no mic button ---
# An OpenAI-compatible API base: https://api.groq.com/openai/v1, https://api.openai.com/v1, or Speaches'
# http://<host>:8000/v1. The server posts WAV segments to <url>/audio/transcriptions.
# @type=url
TRANSCRIBE_URL=
# @sensitive
TRANSCRIBE_API_KEY=
# e.g. whisper-large-v3-turbo (Groq), gpt-transcribe (OpenAI), Systran/faster-whisper-small (Speaches)
TRANSCRIBE_MODEL=
# ISO 639-1 hint sent with each request unless the person picks one; unset, the backend detects it.
TRANSCRIBE_LANGUAGE=
# Prompt sent with each request, to bias spelling (names, "vos", product terms).
TRANSCRIBE_PROMPT=
# How often the open segment is re-transcribed for live text; 0 sends only final text at each pause.
# @type=number(isInt=true, min=0)
TRANSCRIBE_INTERIM_MS=1000
# Longest dictation; the client stops there and keeps the text.
# @type=number(isInt=true, min=10)
TRANSCRIBE_MAX_SECONDS=300
# Transcription requests at once, across everyone.
# @type=number(isInt=true, min=1)
TRANSCRIBE_CONCURRENCY=2
# @type=duration
TRANSCRIBE_TIMEOUT=30s
```

#55's `TRANSCRIBE_MAX_FILE_MB` is not needed with streamed PCM: `TRANSCRIBE_MAX_SECONDS` bounds the memory (300 s × 32 KB/s ≈ 9.6 MB). A later `TRANSCRIBE_ENGINE=chunked|realtime` would select the Realtime relay. Like `SEARXNG_URL`, the key belongs in `src/config.ts` only and is never sent to `web/`.

## Open questions for the user

1. **Where may audio go?** Cloud (Groq/OpenAI) gives the best quality and speed now; self-hosted keeps audio on the LAN. Recommended: support both through the one URL; default to Groq for daily use if leaving the host is acceptable, Speaches otherwise.
2. **Which machine would run Speaches?** This host has a GTX 1070 Ti (8 GB, Pascal) and an i7-8700K: enough for faster-whisper `large-v3-turbo` int8 on the GPU, not for Voxtral (16 GB). The Ollama box at 192.168.1.20 was unreachable from here; its GPU is unknown. A Raspberry Pi is too slow for Whisper partials (fine for Moonshine).
3. **Live partials every ~1 s, or a phrase at a time?** Recommended: partials (`TRANSCRIBE_INTERIM_MS=1000`) on Groq or a GPU, final-only on CPU.
4. **Spanish, English, or mixed in one message?** Mixed sentences decide between Whisper (one language per request, auto or fixed) and future engines. Recommended: a per-session ES/EN/Auto toggle defaulting to `es`.
5. **Is dictation over the plain-http LAN exposure required?** Browsers forbid the mic there. Recommended: use Tailscale's https URL on phones; the console explains it on http.
6. **Is a zero-config Web Speech mode wanted** (works with no backend, but audio goes to Google/Apple)? Recommended: no for v1; revisit if nobody configures a backend.
7. **Quality check before choosing**: record ten short Rioplatense and English clips and run them through Groq turbo, Speaches `small`/`turbo`, and `gpt-transcribe`. No public benchmark covers Rioplatense specifically (the figures above are FLEURS/MLS Spanish).
8. **Where should this note live?** AGENTS.md keeps unshipped sketches in the git-ignored `docs/plans/`; this was committed under `docs/research/` as asked. Move or drop it once an ADR records the decision.

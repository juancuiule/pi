# Dictation streams PCM to the server, which re-transcribes segments over one OpenAI-compatible URL

The composer's mic shows live text while the person speaks. The browser streams 16 kHz mono PCM16 over `GET /api/dictation`; the server cuts it into segments at pauses (an energy VAD), re-transcribes the open segment about once a second for interim text, and transcribes it once more as final when a pause closes it. Every request is a WAV posted to `<TRANSCRIBE_URL>/audio/transcriptions`, so the backend is configuration: a local Speaches (faster-whisper) by default, Groq or OpenAI by changing three variables. The options compared are in [docs/research/dictation.md](../research/dictation.md).

## Decisions

- **Pseudo-streaming over the batch endpoint, not a streaming protocol.** `/audio/transcriptions` is served by every candidate, local or cloud. True streaming (OpenAI Realtime, Deepgram, Voxtral on vLLM) needs a paid API or a GPU with 16 GB or more, which this host lacks. A `realtime` engine can come later behind the same socket.
- **The server is the only thing that talks to the speech service.** The browser never holds a provider key and needs no CORS or ephemeral tokens; audio leaves the host only when `TRANSCRIBE_URL` is a cloud one.
- **PCM from an AudioWorklet, not MediaRecorder chunks.** A chunk after the first has no container header, Safari recorded MP4 before 18.4, and the server needs samples for its VAD anyway. 32 KB/s is nothing for a LAN or a tunnel, and the server builds WAV without an encoder.
- **Silence is never sent.** Whisper invents text for silence ("Gracias por ver el video"), so only segments with speech go out, trimmed to 300 ms of tail.
- **One request in flight per dictation, finals first.** Finals reach the client in segment order, and a slow backend lowers the interim cadence instead of queueing. The previous finals are sent as the prompt, for continuity.
- **Per User, not per Conversation.** The New conversation form has no Conversation yet, so the route checks only the session. It is a socket outside the HttpApi and outside `conversations/:id`, so its 401 test is written by hand and the edge (`deploy/Caddyfile`) routes it to the server.
- **Final text goes where the caret was at the start**, each final after the previous one, shifting with edits made meanwhile; interim text stays in a strip above the textarea, because a textarea cannot style part of its text.
- **Language is the person's choice per dictation** (ES, the default, EN or Auto, remembered per browser): Whisper detects once per request, so mixed or short segments come out better pinned.
- **No microphone over plain http.** Browsers expose `getUserMedia` only in secure contexts; the `lan` exposure stays http, and the button says to use the https URL.

## Considered options

- Batch after stop (#55 as first written): simplest, no live text.
- Web Speech API: least code, but audio goes to Google or Apple by default and on-device mode is desktop-only.
- In-browser models (Moonshine, Whisper on WebGPU): private, but monolingual or heavy, and untested on phones.

# Speaches: local speech-to-text for dictation

[Speaches](https://github.com/speaches-ai/speaches) serves faster-whisper behind an OpenAI-compatible `/v1/audio/transcriptions`. The server posts each spoken segment of a dictation to it (`src/dictation/`, decisions in `docs/adr/0013-dictation-segments-over-one-openai-compatible-url.md`). It listens on `127.0.0.1:8000` only (`SPEACHES_PORT` changes it).

```sh
pnpm speaches:up      # start; GPU when Docker can use it, CPU otherwise (--cpu forces it)
pnpm speaches:down    # stop; the downloaded models stay in the speaches_hf-hub-cache volume
```

`speaches:up` waits until the model is downloaded (the first time takes minutes for a large model), loads it with a first request, and adds `TRANSCRIBE_URL=http://127.0.0.1:8000/v1` and `TRANSCRIBE_MODEL` to `.env` when they are not set. Restart the server afterwards; the composer then shows the mic button.

## GPU prerequisite

The CUDA image needs the NVIDIA driver on the host (`nvidia-smi` works) and the NVIDIA runtime in Docker, which `speaches:up` looks for in `docker info`. Without it, it starts the CPU image and says so. To add the runtime on Debian or Ubuntu, install `nvidia-container-toolkit` from NVIDIA's apt repository ([install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)), then:

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}'   # lists "nvidia"
pnpm speaches:down && pnpm speaches:up
```

The image is CUDA 12.4.1, which NVIDIA drivers from 550 support. Models run in int8 (`WHISPER__COMPUTE_TYPE`): on a Pascal card such as the GTX 1070 Ti, float16 has no throughput, and int8 needs compute capability 6.1, which Pascal has.

## Models

| Model | Where | Notes |
| --- | --- | --- |
| `deepdml/faster-whisper-large-v3-turbo-ct2` | default on a GPU | large-v3's encoder with 4 decoder layers; about 1 GB of VRAM in int8 |
| `Systran/faster-whisper-small` | default on a CPU | about 2-3 s per segment on an i7-8700K, so live text every few seconds |
| `Systran/faster-whisper-medium` | to compare | between the two |
| `Systran/faster-whisper-large-v3` | to compare | the most accurate, slower; fits 8 GB in int8 |
| `Systran/faster-distil-whisper-large-v3` | English only | the comparison runs it on `en` clips only |

Set `TRANSCRIBE_MODEL` to change it; `speaches:up` downloads and loads whichever is set. Whisper decodes a 30-second window whatever the segment's length, so a short segment costs about as much as a long one: the per-request time, not the audio length, sets how often live text updates.

## Comparing models on your own voice

Record short clips the way you would dictate (10-30 s each, Rioplatense Spanish and English), and put them in a folder by language, each with what you said beside it if you want a word error rate:

```
clips/
  es/
    reunion.m4a
    reunion.txt     # optional: the exact words, for the WER
  en/
    standup.wav
    standup.txt
```

```sh
pnpm speaches:compare clips/                      # every model above
pnpm speaches:compare clips/ --models Systran/faster-whisper-small,deepdml/faster-whisper-large-v3-turbo-ct2
pnpm speaches:compare clips/ --auto               # also with the language detected, not pinned
```

The language comes from the folder (`es/`, `en/`) or a name prefix (`es-reunion.m4a`). Any format Speaches decodes works (wav, m4a, mp3, webm, ogg, flac); a phone's voice memo is fine. It prints each transcript with its latency, then a table per model and language: median milliseconds per clip, real-time factor and mean WER (lowercase, punctuation ignored, accents counted). A JSON report lands in the folder. Pick the model with the WER you accept at a latency under `TRANSCRIBE_INTERIM` (1 s by default) for a segment of a few seconds.

## Other backends

The app talks to any OpenAI-compatible endpoint; Speaches is only the local one. In `.env`:

```sh
# Groq: fast, $0.04/h, but every request is billed at least 10 s
TRANSCRIBE_URL=https://api.groq.com/openai/v1
TRANSCRIBE_API_KEY=gsk_...
TRANSCRIBE_MODEL=whisper-large-v3-turbo

# OpenAI: gpt-transcribe, not whisper-1 (deprecated, shut down on 2027-02-26)
TRANSCRIBE_URL=https://api.openai.com/v1
TRANSCRIBE_API_KEY=sk-...
TRANSCRIBE_MODEL=gpt-transcribe
```

With a cloud backend the audio leaves this host. With `TRANSCRIBE_INTERIM` at 1 s, a minute of speech is about 60 requests; `TRANSCRIBE_INTERIM=0` sends only one request per segment.

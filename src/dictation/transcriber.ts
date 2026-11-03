// The speech-to-text backend behind dictation: one OpenAI-compatible `POST <url>/audio/transcriptions` per segment
// (OpenAI, Groq, a local Speaches), with a WAV body built from the socket's PCM. Nothing vendor-specific: the URL,
// key and model are configuration. A semaphore caps requests across every dictation on this server.
import { Context, Effect, Layer, Schema, Semaphore } from "effect";

import { wavOf } from "./audio.ts";

/** A transcription that failed: unreachable, timed out, refused, or answered something unreadable. */
export class TranscribeError extends Schema.TaggedError<TranscribeError>()(
  "TranscribeError",
  { message: Schema.String }
) {}

/** What one request asks for beside the audio. */
export interface TranscribeRequest {
  /** ISO 639-1; unset, the backend detects the language. */
  readonly language?: string | undefined;
  /** Text the backend continues from: earlier segments, and the configured spelling hints. */
  readonly prompt?: string | undefined;
}

export interface OpenAiCompatibleOptions {
  /** The API base, e.g. `http://127.0.0.1:8000/v1`; `/audio/transcriptions` is appended. */
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

const TranscriptionResponse = Schema.Struct({ text: Schema.String });

const fail = (message: string) => new TranscribeError({ message });

/** One request to an OpenAI-compatible transcription endpoint; interrupting it aborts the request. */
export const openAiTranscribe = (
  options: Omit<OpenAiCompatibleOptions, "concurrency">,
  audio: Int16Array,
  sampleRate: number,
  request: TranscribeRequest
): Effect.Effect<string, TranscribeError> =>
  Effect.gen(function* () {
    const form = new FormData();
    form.set(
      "file",
      new Blob([wavOf(audio, sampleRate)], { type: "audio/wav" }),
      "dictation.wav"
    );
    form.set("model", options.model);
    form.set("response_format", "json");
    form.set("temperature", "0");
    if (request.language !== undefined) {
      form.set("language", request.language);
    }
    if (request.prompt !== undefined && request.prompt !== "") {
      form.set("prompt", request.prompt);
    }
    const url = `${options.url.replace(/\/+$/u, "")}/audio/transcriptions`;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          body: form,
          headers:
            options.apiKey === undefined
              ? {}
              : { authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs),
          ]),
        }),
      catch: (cause) =>
        fail(
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? `The transcription timed out after ${options.timeoutMs}ms`
            : `The transcription could not reach ${options.url}: ${cause instanceof Error ? cause.message : String(cause)}`
        ),
    });
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text().catch(() => ""));
      return yield* fail(
        `The transcription service answered ${response.status} ${response.statusText}${body === "" ? "" : `: ${body.slice(0, 300)}`}`
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        fail(`The transcription service answered malformed JSON: ${cause}`),
    });
    const decoded = yield* Schema.decodeUnknownEffect(TranscriptionResponse)(
      body
    ).pipe(
      Effect.mapError((cause) =>
        fail(`The transcription response did not decode: ${cause.message}`)
      )
    );
    return decoded.text.trim();
  });

export class Transcriber extends Context.Service<
  Transcriber,
  {
    /** The text of `audio` (mono PCM16 at `sampleRate`). */
    readonly transcribe: (
      audio: Int16Array,
      sampleRate: number,
      request: TranscribeRequest
    ) => Effect.Effect<string, TranscribeError>;
  }
>()("effect-pi/dictation/Transcriber") {
  /** A Transcriber over an OpenAI-compatible endpoint, at most `concurrency` requests at once. */
  static readonly openAiCompatible = (options: OpenAiCompatibleOptions) =>
    Layer.effect(
      Transcriber,
      Effect.gen(function* () {
        const slots = yield* Semaphore.make(options.concurrency);
        return Transcriber.of({
          transcribe: (audio, sampleRate, request) =>
            openAiTranscribe(options, audio, sampleRate, request).pipe(
              slots.withPermits(1)
            ),
        });
      })
    );

  /**
   * A Transcriber for tests: `answer` gets each request (with the audio's length in milliseconds) and returns the
   * text, an Error to fail it, or an Effect (to delay or block it).
   */
  static readonly fake = (
    answer: (request: {
      readonly audio: Int16Array;
      readonly ms: number;
      readonly language: string | undefined;
      readonly prompt: string | undefined;
    }) => string | Error | Effect.Effect<string, TranscribeError>
  ): Layer.Layer<Transcriber> =>
    Layer.succeed(
      Transcriber,
      Transcriber.of({
        transcribe: (audio, sampleRate, request) =>
          Effect.suspend(() => {
            const answered = answer({
              audio,
              ms: Math.round((audio.length / sampleRate) * 1000),
              language: request.language,
              prompt: request.prompt,
            });
            if (typeof answered === "string") {
              return Effect.succeed(answered);
            }
            return answered instanceof Error
              ? Effect.fail(fail(answered.message))
              : answered;
          }),
      })
    );
}

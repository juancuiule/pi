// One dictation: the audio a socket sends, cut into segments at pauses, and the interim and final text sent back.
// One request per session is in flight at a time, finals before interims, so finals reach the client in segment
// order and a slow backend lowers the interim cadence instead of queueing requests. Silence is never transcribed
// (see Segmenter). The route (src/server/dictation.ts) feeds `audio`/`stop` from the socket and runs `run`.
import { Effect, Schedule } from "effect";

import { pcmOf, Segmenter } from "./audio.ts";
import type { Segment } from "./audio.ts";
import { DICTATION_SAMPLE_RATE } from "./protocol.ts";
import type { DictationLanguage, DictationServerMessage } from "./protocol.ts";
import { Transcriber } from "./transcriber.ts";
import type { TranscribeError } from "./transcriber.ts";

/** The server's dictation settings (TRANSCRIBE_* in .env.schema); durations in milliseconds. */
export interface DictationOptions {
  /** How often the open segment is re-transcribed for live text; 0 sends only finals. */
  readonly interimMs: number;
  /** The longest dictation, in seconds of audio. */
  readonly maxSeconds: number;
  /** Spelling hints sent with every request (names, "vos", product terms). */
  readonly prompt?: string | undefined;
  /** How long a pause closes a segment. */
  readonly pauseMs?: number | undefined;
}

/** A segment shorter than this in speech is a click or a cough: not sent. */
const MIN_SPEECH_MS = 200;
/** New audio an interim needs since the last one, so a request is not spent on the same words. */
const INTERIM_STEP_MS = 300;
/** How often the worker looks for work. */
const TICK_MS = 40;
/** Whisper's prompt holds 224 tokens; the end of what was said is what matters. */
const CONTEXT_CHARS = 600;

const msOf = (samples: number) =>
  Math.round((samples / DICTATION_SAMPLE_RATE) * 1000);

/** What a finished session did, for its span. */
export interface DictationStats {
  readonly seconds: number;
  readonly segments: number;
  readonly requests: number;
  readonly outcome: "done" | "error";
}

/**
 * A dictation session, `ready` sent: `audio` takes a binary frame, `stop` ends the input (the open segment is finished and
 * `done` follows), and `run` does the transcribing until then; interrupt `run` to cancel. `send` delivers each
 * message to the client.
 */
export const dictationSession = Effect.fnUntraced(function* (
  options: DictationOptions & {
    readonly language: DictationLanguage | null;
    readonly send: (message: DictationServerMessage) => Effect.Effect<void>;
  }
) {
  const transcriber = yield* Transcriber;
  const segmenter = new Segmenter({
    sampleRate: DICTATION_SAMPLE_RATE,
    pauseMs: options.pauseMs,
  });
  const maxSamples = options.maxSeconds * DICTATION_SAMPLE_RATE;
  const closed: Segment[] = [];
  let received = 0;
  let stopped = false;
  let requests = 0;
  let segments = 0;
  // What was finalized so far, the context of the next request.
  let context = "";
  let interim:
    | { readonly id: number; samples: number; at: number; text: string }
    | undefined;

  const take = (segment: Segment | undefined) => {
    if (segment !== undefined && segment.speechMs >= MIN_SPEECH_MS) {
      closed.push(segment);
    }
  };

  const transcribe = (audio: Int16Array) => {
    requests += 1;
    const prompt = [options.prompt, context.slice(-CONTEXT_CHARS)]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    return transcriber
      .transcribe(audio, DICTATION_SAMPLE_RATE, {
        language: options.language ?? undefined,
        prompt,
      })
      .pipe(Effect.retry(Schedule.recurs(1)));
  };

  const audio = (bytes: Uint8Array) =>
    Effect.gen(function* () {
      if (stopped) {
        return;
      }
      const room = maxSamples - received;
      const samples = pcmOf(bytes).subarray(0, Math.max(0, room));
      received += samples.length;
      for (const segment of segmenter.feed(samples)) {
        take(segment);
      }
      if (received >= maxSamples) {
        yield* options.send({ type: "limit" });
        stopped = true;
        take(segmenter.flush());
      }
    });

  const stop = Effect.sync(() => {
    if (!stopped) {
      stopped = true;
      take(segmenter.flush());
    }
  });

  /** One step: a final if one is due, else an interim if one is due; false when there was nothing to do. */
  const step: Effect.Effect<boolean, TranscribeError> = Effect.gen(
    function* () {
      const segment = closed.shift();
      if (segment !== undefined) {
        const text = yield* transcribe(segment.audio);
        segments += 1;
        context = `${context} ${text}`.trim();
        interim = undefined;
        yield* options.send({ type: "final", segment: segment.id, text });
        return true;
      }
      const open = stopped ? undefined : segmenter.open();
      if (
        options.interimMs <= 0 ||
        open === undefined ||
        open.speechMs < MIN_SPEECH_MS
      ) {
        return false;
      }
      const now = Date.now();
      const last = interim?.id === open.id ? interim : undefined;
      if (
        last !== undefined &&
        (now - last.at < options.interimMs ||
          msOf(open.audio.length - last.samples) < INTERIM_STEP_MS)
      ) {
        return false;
      }
      const text = yield* transcribe(open.audio);
      const previous = last?.text;
      interim = { id: open.id, samples: open.audio.length, at: now, text };
      // A pause may have closed the segment while this ran: its final follows, and the interim is stale.
      if (segmenter.open()?.id === open.id && text !== previous) {
        yield* options.send({ type: "interim", segment: open.id, text });
      }
      return true;
    }
  );

  const run: Effect.Effect<DictationStats> = Effect.gen(function* () {
    while (true) {
      const worked = yield* step;
      if (!worked) {
        if (stopped && closed.length === 0) {
          yield* options.send({ type: "done" });
          return "done" as const;
        }
        yield* Effect.sleep(TICK_MS);
      }
    }
  }).pipe(
    Effect.catchTag("TranscribeError", (failure) =>
      Effect.as(
        Effect.andThen(
          Effect.logWarning("Dictation stopped: transcription failed", failure),
          options.send({
            type: "error",
            reason: "unavailable",
            message: failure.message,
          })
        ),
        "error" as const
      )
    ),
    Effect.map((outcome) => ({
      seconds: Math.round(msOf(received) / 100) / 10,
      segments,
      requests,
      outcome,
    }))
  );

  yield* options.send({
    type: "ready",
    maxSeconds: options.maxSeconds,
    interim: options.interimMs > 0,
  });
  return { audio, stop, run };
});

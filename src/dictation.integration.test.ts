// One real dictation against the transcription service at TRANSCRIBE_URL (`pnpm speaches:up` writes it), through the
// same session and Transcriber the server wires: a recorded "Front center" (alsa-utils' test sound) goes in as the
// socket's 16 kHz PCM, and its final text comes out. `pnpm test:integration`; skipped without the URL or the clip.
import { existsSync, readFileSync } from "node:fs";

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { DictationServerMessage } from "./dictation/protocol.ts";
import { dictationSession } from "./dictation/session.ts";
import { Transcriber } from "./dictation/transcriber.ts";
import { pcmBytes } from "./testing/dictation.ts";

const url = process.env.TRANSCRIBE_URL;
const model = process.env.TRANSCRIBE_MODEL;
const CLIP = "/usr/share/sounds/alsa/Front_Center.wav";

/** The clip's samples at 16 kHz: a 48 kHz mono PCM16 WAV, every third sample. */
const clip16k = () => {
  const bytes = readFileSync(CLIP);
  const data = bytes.indexOf("data") + 8;
  const all = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + data, bytes.byteOffset + bytes.length)
  );
  return all.filter((_, index) => index % 3 === 0);
};

describe("dictation against a real transcription service", () => {
  it.skipIf(
    url === undefined || url === "" || model === undefined || !existsSync(CLIP)
  )(
    "turns spoken audio into final text",
    async () => {
      const sent = await Effect.runPromise(
        Effect.gen(function* () {
          const messages: DictationServerMessage[] = [];
          const session = yield* dictationSession({
            interimMs: 0,
            maxSeconds: 60,
            language: "en",
            send: (message) => Effect.sync(() => messages.push(message)),
          });
          const worker = yield* Effect.forkChild(session.run);
          const audio = clip16k();
          for (let at = 0; at < audio.length; at += 1600) {
            yield* session.audio(pcmBytes(audio.slice(at, at + 1600)));
          }
          yield* session.stop;
          yield* Fiber.join(worker);
          return messages;
        }).pipe(
          Effect.provide(
            Transcriber.openAiCompatible({
              url: url as string,
              apiKey: process.env.TRANSCRIBE_API_KEY || undefined,
              model: model as string,
              timeoutMs: 60_000,
              concurrency: 1,
            })
          )
        )
      );

      const finals = sent.flatMap((message) =>
        message.type === "final" ? [message.text] : []
      );
      expect(finals.join(" ").toLowerCase()).toMatch(/front.*center/u);
      expect(sent.at(-1)).toStrictEqual({ type: "done" });
    },
    120_000
  );
});

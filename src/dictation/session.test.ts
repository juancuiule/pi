import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { framesOf, silence, speech } from "../testing/dictation.ts";
import type { DictationServerMessage } from "./protocol.ts";
import { dictationSession } from "./session.ts";
import type { DictationOptions } from "./session.ts";
import { Transcriber } from "./transcriber.ts";

const concat = (...parts: Int16Array[]) => {
  const all = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

/** Runs a session over `audio` (sent at once, then `stop`), with `answer` as the backend; returns what it sent. */
const dictate = (
  audio: Int16Array,
  answer: Parameters<typeof Transcriber.fake>[0],
  options: Partial<DictationOptions> & {
    readonly language?: "es" | "en" | null;
    /** Waits between frames, so interims have time to happen. */
    readonly paceMs?: number;
    readonly stop?: boolean;
  } = {}
) =>
  Effect.gen(function* () {
    const sent: DictationServerMessage[] = [];
    const session = yield* dictationSession({
      interimMs: options.interimMs ?? 0,
      maxSeconds: options.maxSeconds ?? 60,
      pauseMs: options.pauseMs ?? 400,
      prompt: options.prompt,
      language: options.language === undefined ? "es" : options.language,
      send: (message) => Effect.sync(() => sent.push(message)),
    });
    const worker = yield* Effect.forkChild(session.run);
    for (const frame of framesOf(audio)) {
      yield* session.audio(frame);
      if (options.paceMs !== undefined) {
        yield* Effect.sleep(options.paceMs);
      }
    }
    if (options.stop ?? true) {
      yield* session.stop;
    }
    const stats = yield* Fiber.join(worker);
    return { sent, stats };
  }).pipe(Effect.provide(Transcriber.fake(answer)));

const types = (sent: readonly DictationServerMessage[]) =>
  sent.map((message) => message.type);

describe(dictationSession, () => {
  it("sends one final per spoken segment, in order, then done", async () => {
    let calls = 0;
    const { sent, stats } = await Effect.runPromise(
      dictate(
        concat(speech(600), silence(600), speech(600), silence(600)),
        () => {
          calls += 1;
          return `segment ${calls}`;
        }
      )
    );
    expect(sent).toStrictEqual([
      { type: "ready", maxSeconds: 60, interim: false },
      { type: "final", segment: 0, text: "segment 1" },
      { type: "final", segment: 1, text: "segment 2" },
      { type: "done" },
    ]);
    expect(stats).toMatchObject({ segments: 2, requests: 2, outcome: "done" });
  });

  it("never transcribes silence", async () => {
    const { sent } = await Effect.runPromise(
      dictate(silence(3000), () => "Gracias por ver el video")
    );
    expect(types(sent)).toStrictEqual(["ready", "done"]);
  });

  it("sends interim text while a segment is spoken, then its final", async () => {
    let calls = 0;
    const { sent } = await Effect.runPromise(
      dictate(
        concat(speech(1500), silence(500)),
        ({ ms }) => {
          calls += 1;
          return `heard ${ms} ms (${calls})`;
        },
        { interimMs: 100, paceMs: 100 }
      )
    );
    const interims = sent.filter((message) => message.type === "interim");
    expect({
      several: interims.length > 1,
      segments: [...new Set(interims.map((message) => message.segment))],
      end: types(sent).slice(-2),
    }).toStrictEqual({ several: true, segments: [0], end: ["final", "done"] });
  });

  it("passes the language, the configured prompt and what was said before", async () => {
    const requests: {
      language: string | undefined;
      prompt: string | undefined;
    }[] = [];
    await Effect.runPromise(
      dictate(
        concat(speech(500), silence(500), speech(500), silence(500)),
        ({ language, prompt }) => {
          requests.push({ language, prompt });
          return "che, boludo";
        },
        { language: "es", prompt: "Pi, Effect" }
      )
    );
    expect(requests).toStrictEqual([
      { language: "es", prompt: "Pi, Effect" },
      { language: "es", prompt: "Pi, Effect che, boludo" },
    ]);
  });

  it("lets the backend detect the language when none is pinned", async () => {
    const languages: (string | undefined)[] = [];
    await Effect.runPromise(
      dictate(
        concat(speech(500), silence(500)),
        ({ language }) => {
          languages.push(language);
          return "hello";
        },
        { language: null }
      )
    );
    expect(languages).toStrictEqual([undefined]);
  });

  it("retries a failed request once, then reports the backend unavailable", async () => {
    let calls = 0;
    const { sent, stats } = await Effect.runPromise(
      dictate(concat(speech(500), silence(500)), () => {
        calls += 1;
        return new Error("connection refused");
      })
    );
    expect(calls).toBe(2);
    expect(sent.at(-1)).toStrictEqual({
      type: "error",
      reason: "unavailable",
      message: "connection refused",
    });
    expect(stats.outcome).toBe("error");
  });

  it("stops listening at the limit and finishes what was said", async () => {
    const { sent } = await Effect.runPromise(
      dictate(speech(12_000), () => "long", {
        maxSeconds: 10,
        stop: false,
      })
    );
    expect(types(sent)).toStrictEqual(["ready", "limit", "final", "done"]);
  });

  it("drops an interim that a pause made stale", async () => {
    const release = Deferred.makeUnsafe<string>();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sent: DictationServerMessage[] = [];
        const session = yield* dictationSession({
          interimMs: 10,
          maxSeconds: 60,
          pauseMs: 400,
          language: "es",
          send: (message) => Effect.sync(() => sent.push(message)),
        });
        const worker = yield* Effect.forkChild(session.run);
        for (const frame of framesOf(speech(400))) {
          yield* session.audio(frame);
        }
        // The interim request is in flight; the pause closes the segment before it answers.
        yield* Effect.sleep(100);
        for (const frame of framesOf(silence(600))) {
          yield* session.audio(frame);
        }
        yield* Deferred.succeed(release, "stale");
        yield* session.stop;
        yield* Fiber.join(worker);
        return sent;
      }).pipe(
        Effect.provide(
          Transcriber.fake(({ ms }) =>
            ms < 500 ? Deferred.await(release) : "final"
          )
        )
      )
    );
    expect(types(result)).toStrictEqual(["ready", "final", "done"]);
  });
});

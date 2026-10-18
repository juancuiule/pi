import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { fauxAgents, openSeat } from "../testing/faux.ts";
import { Agents } from "./agents.ts";

const ok = () => fauxAssistantMessage([fauxText("ok")]);

// A 24k window compacts like in agents.history.test.ts: four ~10k-token prompts leave the first
// exchanges hidden behind a head marker.
const prompt = (mark: string) => `${mark} ${"x".repeat(40_000)}`;

describe("Agents.entries", () => {
  it("emits every transcript entry oldest first, of every kind", async () => {
    const { layer } = fauxAgents([ok()]);

    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.ask("hi");
          const stream = yield* agents.entries(seat.id);
          return yield* Stream.runCollect(stream);
        })
      ).pipe(Effect.provide(layer))
    );

    const all = [...entries];
    const kinds = all.map((entry) => entry.kind);
    expect(kinds).toContain("pi.user");
    expect(kinds).toContain("pi.assistant");
    const ids = all.map((entry) => Number(entry.id));
    expect(ids).toStrictEqual(ids.toSorted((a, b) => a - b));
  });

  it("resumes from an exclusive lower entry-id bound", async () => {
    const { layer } = fauxAgents([ok(), ok()]);

    const { whole, rest } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.ask("first");
          yield* seat.ask("second");
          const all = [
            ...(yield* Stream.runCollect(yield* agents.entries(seat.id))),
          ];
          const resumed = [
            ...(yield* Stream.runCollect(
              yield* agents.entries(seat.id, {
                from: Number(all[1]?.id),
              })
            )),
          ];
          return { whole: all, rest: resumed };
        })
      ).pipe(Effect.provide(layer))
    );

    const from = Number(whole[1]?.id);
    expect(rest.map((entry) => Number(entry.id))).toStrictEqual(
      whole.map((entry) => Number(entry.id)).filter((id) => id > from)
    );
    expect(rest.length).toBeGreaterThan(0);
  });

  it("fails with ConversationNotFound for an unknown id", async () => {
    const { layer } = fauxAgents([]);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const agents = yield* Agents;
        return yield* agents.entries(999_999 as ConversationId);
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("includes the entries a compaction hides", async () => {
    const { layer } = fauxAgents(Array.from({ length: 8 }, ok), {
      contextWindow: 24_576,
    });

    const { hidden, all } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          for (const mark of ["markone", "marktwo", "markthree", "markfour"]) {
            yield* seat.ask(prompt(mark));
          }
          const page = yield* agents.history(seat.id);
          const entries = [
            ...(yield* Stream.runCollect(yield* agents.entries(seat.id))),
          ];
          return { hidden: page, all: entries };
        })
      ).pipe(Effect.provide(layer))
    );

    // Everything history reports as hidden is in the full scan, and so is the newest prompt.
    for (const entry of hidden.entries) {
      expect(all.some((each) => each.id === entry.id)).toBeTruthy();
    }
    const text = JSON.stringify(all.map((entry) => entry.model));
    expect(hidden.entries.length).toBeGreaterThan(0);
    expect(text).toContain("markone");
    expect(text).toContain("markfour");
  }, 30_000);
});

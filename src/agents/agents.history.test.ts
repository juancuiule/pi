import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ConversationEvent, HistoryPage } from "../conversation-events.ts";
import { fauxAgents, openSeat } from "../testing/faux.ts";
import { Agents } from "./agents.ts";

const ok = () => fauxAssistantMessage([fauxText("ok")]);

const prompt = (mark: string) => `${mark} ${"x".repeat(40_000)}`;

const firstOf = <E, R>(stream: Stream.Stream<ConversationEvent, E, R>) =>
  stream
    .pipe(Stream.take(1), Stream.runCollect)
    .pipe(Effect.map((chunk) => [...chunk][0]));

// A 24k window makes every run over the 16k reserve blocking once the transcript is large enough to cut: four
// ~10k-token prompts let `selectCut` keep the newest ~20k tokens and hide the first exchange.
const compacted = Effect.gen(function* () {
  const agents = yield* Agents;
  const conversation = yield* openSeat({ sandbox: "none" });
  for (const mark of ["one", "two", "three", "four"]) {
    yield* conversation.ask(prompt(mark));
  }
  const snapshot = yield* agents
    .events(conversation.id)
    .pipe(Effect.flatMap(firstOf));
  const full = yield* agents.history(conversation.id);
  return { agents, id: conversation.id, snapshot, full };
});

const entryText = (entry: HistoryPage["entries"][number]) => {
  const message = entry.model?.[0];
  if (message?.role !== "user") {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("");
};

describe("Agents.history", () => {
  it("is empty and snapshots report no earlier entries without a head marker", async () => {
    const { layer } = fauxAgents([ok()]);

    const { snapshot, page } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* openSeat({ sandbox: "none" });
          yield* conversation.ask("hi");
          const first = yield* agents
            .events(conversation.id)
            .pipe(Effect.flatMap(firstOf));
          const history = yield* agents.history(conversation.id);
          return { snapshot: first, page: history };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(snapshot?.type).toBe("snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.earlier).toBeFalsy();
    expect(page).toStrictEqual({ entries: [], earlier: false });
  });

  it("fails with ConversationNotFound for an unknown id", async () => {
    const { layer } = fauxAgents([]);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const agents = yield* Agents;
        return yield* agents.history(999_999 as ConversationId);
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("returns the entries a compaction hides, oldest first", async () => {
    const { layer } = fauxAgents(Array.from({ length: 8 }, ok), {
      contextWindow: 24_576,
    });

    const { snapshot, full } = await Effect.runPromise(
      Effect.scoped(compacted).pipe(Effect.provide(layer))
    );

    expect(snapshot?.type === "snapshot" && snapshot.earlier).toBeTruthy();
    // The hidden prefix is the whole transcript up to the cut, oldest first.
    const ids = full.entries.map((entry) => Number(entry.id));
    expect(full.entries.length).toBeGreaterThan(1);
    expect(ids).toStrictEqual(ids.toSorted((a, b) => a - b));
    expect(
      full.entries.some((entry) => entryText(entry).startsWith("one "))
    ).toBeTruthy();
  });

  it("pages back with `before` and reports when a page precedes it", async () => {
    const { layer } = fauxAgents(Array.from({ length: 8 }, ok), {
      contextWindow: 24_576,
    });

    const { full, pageOne, pageTwo } = await Effect.runPromise(
      Effect.scoped(
        compacted.pipe(
          Effect.flatMap(({ agents, id, full: hidden }) =>
            Effect.gen(function* () {
              const newest = yield* agents.history(id, { limit: 2 });
              const oldest = newest.entries.at(0);
              if (oldest === undefined) {
                return yield* Effect.die(new Error("first page was empty"));
              }
              const rest = yield* agents.history(id, {
                before: Number(oldest.id),
                limit: 10,
              });
              return { full: hidden, pageOne: newest, pageTwo: rest };
            })
          )
        )
      ).pipe(Effect.provide(layer))
    );

    expect(pageOne.entries).toHaveLength(2);
    expect(pageOne.earlier).toBeTruthy();
    expect(pageOne.entries.map((entry) => entry.id)).toStrictEqual(
      full.entries.slice(-2).map((entry) => entry.id)
    );
    expect([
      ...pageTwo.entries.map((entry) => entry.id),
      ...pageOne.entries.map((entry) => entry.id),
    ]).toStrictEqual(full.entries.map((entry) => entry.id));
    expect(pageTwo.earlier).toBeFalsy();
  });
});

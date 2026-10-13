import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { fauxAgents } from "./testing/faux.ts";

const assistantTexts = (events: readonly AgentEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== "message_end") {
      return [];
    }
    const message = event.entry.model?.[0];
    return message?.role === "assistant"
      ? [
          message.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join(""),
        ]
      : [];
  });

describe("Agents.events", () => {
  it("starts with a snapshot and streams the run a prompt starts", async () => {
    const { layer } = fauxAgents([fauxAssistantMessage([fauxText("Paris.")])]);

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("Capital of France?");
          return yield* stream.pipe(
            Stream.takeUntil((event) => event.type === "run_end"),
            Stream.runCollect
          );
        })
      ).pipe(Effect.provide(layer))
    );

    const types = Array.from(events, (event) => event.type);
    expect(types[0]).toBe("snapshot");
    expect(types).toContain("run_start");
    expect(types.at(-1)).toBe("run_end");
    expect(assistantTexts([...events])).toStrictEqual(["Paris."]);
  });

  it("queues a prompt sent while the agent runs and answers both", async () => {
    const { layer } = fauxAgents([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ]);

    const texts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("first");
          yield* conversation.send("second");
          const seen: AgentEvent[] = [];
          yield* stream.pipe(
            Stream.takeUntil((event) => {
              seen.push(event);
              return assistantTexts(seen).length === 2;
            }),
            Stream.runDrain
          );
          return assistantTexts(seen);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(texts).toStrictEqual(["one", "two"]);
  });

  it("fails with ConversationNotFound for an unknown id", async () => {
    const { layer } = fauxAgents([]);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const agents = yield* Agents;
        return yield* agents.events(999_999 as ConversationId);
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("keeps working after a watcher is interrupted", async () => {
    const { layer } = fauxAgents([fauxAssistantMessage([fauxText("ok")])]);

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          // Takes the snapshot, then the stream is interrupted, which stops its watch.
          yield* stream.pipe(Stream.take(1), Stream.runDrain);
          return yield* conversation.ask("hi");
        })
      ).pipe(Effect.provide(layer))
    );

    expect(answer).toBe("ok");
  });
});

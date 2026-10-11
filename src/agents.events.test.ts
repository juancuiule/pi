import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

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

  it("reports a subagent's conversation id, whose events can be watched", async () => {
    const { layer } = fauxAgents([
      callTool("subagent", { task: "Name a prime." }),
      fauxAssistantMessage([fauxText("7")]),
      echoToolResult,
    ]);

    const childTexts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("Use a subagent to name a prime.");
          const events = [
            ...(yield* stream.pipe(
              Stream.takeUntil((event) => event.type === "run_end"),
              Stream.runCollect
            )),
          ];
          const [child] = events.flatMap((event) =>
            event.type === "tool_execution_update" &&
            typeof event.details === "object" &&
            event.details !== null &&
            "conversationId" in event.details
              ? [event.details.conversationId]
              : []
          );
          expect(child).toBeTypeOf("number");
          const childStream = yield* agents.events(child as ConversationId);
          const [snapshot] = [
            ...(yield* childStream.pipe(Stream.take(1), Stream.runCollect)),
          ];
          if (snapshot?.type !== "snapshot") {
            throw new Error("expected a snapshot first");
          }
          return snapshot.entries.flatMap((entry) => {
            const message = entry.model?.[0];
            return message?.role === "assistant"
              ? message.content.flatMap((c) =>
                  c.type === "text" ? [c.text] : []
                )
              : [];
          });
        })
      ).pipe(Effect.provide(layer))
    );

    expect(childTexts).toStrictEqual(["7"]);
  });
});

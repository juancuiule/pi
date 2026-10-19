import type { ToolResultMessage } from "@earendil-works/pi-ai";
// Issue #64: an agent run that keeps re-emitting a call whose result it already saw ran unchecked —
// the transcript showed two byte-identical commands alternating ~10 times each until the provider
// errored. A repeat guard now feeds the repeat back to the model and ends the run when it persists.
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents/agents.ts";
import { callTool, fauxAgents, openSeat } from "./testing/faux.ts";

const a = callTool("calculate", { op: "add", a: 1, b: 2 });
const b = callTool("calculate", { op: "multiply", a: 3, b: 4 });

const toolResults = (
  entries: readonly { kind: string; model?: unknown }[]
): ToolResultMessage[] =>
  entries
    .flatMap((entry) =>
      entry.kind === "pi.tool-result"
        ? [entry.model as ToolResultMessage[]]
        : []
    )
    .map((model) => model[0]);

const textOf = (message: ToolResultMessage) =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

describe("repeat guard", () => {
  it("ends a run that keeps re-emitting calls whose results it already saw", async () => {
    // The reported loop: two byte-identical calls in strict alternation.
    const { layer } = fauxAgents([
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b)),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const { results } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.ask("page the git log");
          const entries = [
            ...(yield* Stream.runCollect(yield* agents.entries(seat.id))),
          ];
          return { results: toolResults(entries) };
        })
      ).pipe(Effect.provide(layer))
    );

    // The run ended by itself, well short of the 20 scripted calls.
    expect(results.length).toBeLessThan(20);
    // Repeats past the tolerated streak failed back to the model instead of running again.
    const refused = results.filter((result) => result.isError === true);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(
      refused.map(textOf).some((text) => text.includes("identical"))
    ).toBeTruthy();
  });

  it("leaves a run of distinct calls alone", async () => {
    const { layer } = fauxAgents([
      ...Array.from({ length: 8 }, (_, i) =>
        callTool("calculate", { op: "add", a: i, b: 1 })
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const { answer, results } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          const reply = yield* seat.ask("add up");
          const entries = [
            ...(yield* Stream.runCollect(yield* agents.entries(seat.id))),
          ];
          return { answer: reply, results: toolResults(entries) };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(answer).toBe("done");
    expect(results).toHaveLength(8);
    expect(results.every((result) => result.isError !== true)).toBeTruthy();
  });
});

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

const a = callTool("bash", { command: "echo a" });
const b = callTool("bash", { command: "echo b" });

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
          const seat = yield* openSeat({ sandbox: "shell" });
          yield* seat.ask("page the git log");
          const entries = [
            ...(yield* Stream.runCollect(yield* agents.entries(seat.id))),
          ];
          return { results: toolResults(entries) };
        })
      ).pipe(Effect.provide(layer))
    );

    // The run ended by itself: A executed 3 times, was blocked twice, then ran once more to end
    // it; B executed 3 times and was blocked twice — 11 results of the 20 scripted calls.
    expect(results).toHaveLength(11);
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
        callTool("bash", { command: `echo ${i}` })
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const { answer, results } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat({ sandbox: "shell" });
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

  it("counts identical arguments only while the result stays identical", async () => {
    // The same command emitting a different count each time is progress, not a loop.
    const { layer } = fauxAgents([
      ...Array.from({ length: 8 }, () =>
        callTool("bash", {
          command: "n=$(cat n 2>/dev/null || echo 0); echo $((n + 1)) | tee n",
        })
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const { answer, results } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat({ sandbox: "shell" });
          const reply = yield* seat.ask("count up");
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

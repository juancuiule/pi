import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

describe(Agents, () => {
  it("answers a prompt directly", async () => {
    const { layer } = fauxAgents([fauxAssistantMessage([fauxText("Paris.")])]);

    const answer = await Effect.runPromise(
      ask("What is the capital of France?").pipe(Effect.provide(layer))
    );

    expect(answer).toBe("Paris.");
  });

  it("spawns a subagent and passes its answer back to the parent", async () => {
    const { faux, layer } = fauxAgents([
      callTool("subagent", { task: "Name a prime." }),
      // The subagent's turn
      fauxAssistantMessage([fauxText("7")]),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Use a subagent to name a prime.").pipe(Effect.provide(layer))
    );

    expect(answer).toBe("7");
    expect(faux.getPendingResponseCount()).toBe(0);
  });
});

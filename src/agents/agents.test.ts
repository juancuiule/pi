import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ask, fauxAgents } from "../testing/faux.ts";
import { Agents } from "./agents.ts";

describe(Agents, () => {
  it("answers a prompt directly", async () => {
    const { layer } = fauxAgents([fauxAssistantMessage([fauxText("Paris.")])]);

    const answer = await Effect.runPromise(
      ask("What is the capital of France?").pipe(Effect.provide(layer))
    );

    expect(answer).toBe("Paris.");
  });
});

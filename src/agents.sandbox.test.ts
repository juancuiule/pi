import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

describe("conversation sandboxes", () => {
  it("runs shell tools in the conversation's sandbox and removes it at the end", async () => {
    const { layer, sandboxes } = fauxAgents([
      callTool("bash", { command: "echo hi > note.txt && pwd" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Leave a note.", "shell").pipe(Effect.provide(layer))
    );

    // The tool ran in a sandbox directory, which is gone once the conversation ended.
    expect(answer).toContain("effect-pi-shell-");
    expect(existsSync(answer.trim())).toBeFalsy();
    expect(sandboxes.live.size).toBe(0);
  });

  it("gives a conversation without a sandbox no environment for shell tools", async () => {
    const { layer, sandboxes } = fauxAgents([
      callTool("bash", { command: "pwd" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Where are you?", "none").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("error:");
    expect(sandboxes.live.size).toBe(0);
  });

  it("lets a subagent work in its owner's sandbox", async () => {
    const { layer } = fauxAgents([
      callTool("subagent", { task: "Write the plan." }),
      // The subagent's turns: it writes a file, then answers.
      callTool("write", { path: "plan.md", content: "step 1" }),
      fauxAssistantMessage([fauxText("Written.")]),
      // The parent reads what the subagent wrote.
      callTool("bash", { command: "cat plan.md" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("Have a subagent write a plan, then read it.", "shell").pipe(
        Effect.provide(layer)
      )
    );

    expect(answer).toBe("step 1");
  });

  it("exposes the sandbox to the host while the conversation runs", async () => {
    const { layer } = fauxAgents([
      callTool("write", { path: "out.txt", content: "from the agent" }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const written = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "shell" });
          yield* conversation.ask("Write a file.");
          const dir = conversation.sandbox?.id ?? "";
          return readFileSync(path.join(dir, "out.txt"), "utf-8");
        })
      ).pipe(Effect.provide(layer))
    );

    expect(written).toBe("from the agent");
  });
});

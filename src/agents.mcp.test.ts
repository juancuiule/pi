// MCP servers in Agents: their tools reach conversations, and capabilities report them with the skills.
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { loadSkills } from "./skills.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";
import { fakeMcpServer } from "./testing/mcp.ts";

const echo = fakeMcpServer("test", [
  {
    name: "echo",
    description: "Echo the text back",
    call: (args) => ({
      content: [{ type: "text", text: `echo: ${String(args.text)}` }],
    }),
  },
]);

describe("Agents with MCP servers", () => {
  it("lets a chat conversation call an MCP tool", async () => {
    const agents = fauxAgents(
      [callTool("mcp_test_echo", { text: "hola" }), echoToolResult],
      { mcp: [echo] }
    );
    const answer = await Effect.runPromise(
      ask("echo hola").pipe(Effect.provide(agents.layer))
    );
    expect(answer).toBe("echo: hola");
  });

  it("reports skills and MCP servers as capabilities", async () => {
    const { skills } = loadSkills("skills");
    const down = {
      name: "down",
      url: "memory://down",
      transport: () => {
        throw new Error("refused");
      },
    };
    const agents = fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
      skills,
      mcp: [echo, down],
    });
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Agents;
        return yield* service.capabilities;
      }).pipe(Effect.provide(agents.layer))
    );
    expect(capabilities.skills.map((s) => s.name)).toStrictEqual(
      skills.map((s) => s.name)
    );
    expect(capabilities.skills.map((s) => s.modelInvocable)).toStrictEqual(
      skills.map((s) => !s.disableModelInvocation)
    );
    expect(capabilities.mcp.map((s) => [s.name, s.status])).toStrictEqual([
      ["test", "connected"],
      ["down", "unavailable"],
    ]);
  });
});

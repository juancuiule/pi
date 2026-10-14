import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// MCP servers in Agents: their tools reach conversations, and capabilities report them with the skills.
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "../mcp.ts";
import { Skills } from "../skills/skills.ts";
import {
  ask,
  callTool,
  echoToolResult,
  fauxAgents,
  openSeat,
} from "../testing/faux.ts";
import { fakeMcpServer } from "../testing/mcp.ts";
import { Agents } from "./agents.ts";

const echo = fakeMcpServer("test", [
  {
    name: "echo",
    description: "Echo the text back",
    call: (args) => ({
      content: [{ type: "text", text: `echo: ${String(args.text)}` }],
    }),
  },
]);

/** `echo`'s server while it cannot be reached. */
const echoDown = {
  name: "test",
  url: "memory://test",
  transport: () => {
    throw new Error("refused");
  },
};

/** One Agents layer over `dbFile`, as one run of the server. */
const run = <A, E>(
  dbFile: string,
  responses: Parameters<typeof fauxAgents>[0],
  mcp: readonly McpServerConfig[],
  program: Effect.Effect<A, E, Agents>
) =>
  Effect.promise(() => openNodeSqliteStorage(dbFile)).pipe(
    Effect.flatMap((storage) =>
      program.pipe(
        Effect.provide(fauxAgents(responses, { storage, mcp }).layer)
      )
    )
  );

describe("Agents with MCP servers", () => {
  it("gives a chat created while its server was down the tools once it is back", async () => {
    const dbFile = path.join(
      mkdtempSync(path.join(tmpdir(), "mcp-")),
      "db.sqlite"
    );
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const id = yield* run(
          dbFile,
          [fauxAssistantMessage([fauxText("ok")])],
          [echoDown],
          Effect.scoped(
            Effect.gen(function* () {
              const conversation = yield* openSeat({ sandbox: "none" });
              yield* conversation.ask("hi");
              return conversation.id;
            })
          )
        );
        return yield* run(
          dbFile,
          [callTool("mcp_test_echo", { text: "hola" }), echoToolResult],
          [echo],
          Effect.scoped(
            Effect.gen(function* () {
              const agents = yield* Agents;
              const conversation = yield* agents.open(id);
              return yield* conversation.ask("echo hola");
            })
          )
        );
      })
    );
    expect(answer).toBe("echo: hola");
  });

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

  it("waits for each MCP server only as long as configured", async () => {
    const hanging = fakeMcpServer("slow", [], { hang: true });
    const agents = fauxAgents([], { mcp: [hanging], mcpConnectTimeoutMs: 50 });
    const started = Date.now();
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Agents;
        return yield* service.capabilities;
      }).pipe(Effect.provide(agents.layer))
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(capabilities.mcp.map((s) => [s.name, s.status])).toStrictEqual([
      ["slow", "unavailable"],
    ]);
  });

  it("reports skills and MCP servers as capabilities", async () => {
    const unreachable = {
      name: "down",
      url: "memory://down",
      transport: () => {
        throw new Error("refused");
      },
    };
    const agents = fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
      skills: Skills.directory("skills"),
      mcp: [echo, unreachable],
    });
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Agents;
        return yield* service.capabilities;
      }).pipe(Effect.provide(agents.layer))
    );
    expect(
      capabilities.skills.map((s) => [s.name, s.modelInvocable])
    ).toStrictEqual([
      ["desktop-notes", true],
      ["repo-report", true],
      ["unit-conversion", true],
    ]);
    expect(capabilities.mcp.map((s) => [s.name, s.status])).toStrictEqual([
      ["test", "connected"],
      ["down", "unavailable"],
    ]);
  });
});

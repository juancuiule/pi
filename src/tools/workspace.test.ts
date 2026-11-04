import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
} from "../testing/faux.ts";
import { alice } from "../testing/users.ts";
import { workspaceSection } from "./workspace.ts";

const MENTIONS = "`@path` names a path under /workspace";

describe("the workspace section", () => {
  it("explains `@path` mentions once the conversation has files, from the next request after an Upgrade", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const [before, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* agents.create({
            owner: alice.id,
            prompt: "",
            title: "",
            level: "none",
            createdAt: 0,
          });
          const seat = yield* agents.open(id);
          const first = yield* seat.ask("Hello");
          yield* seat.upgrade({ level: "shell" });
          const second = yield* seat.ask("Look at @src/app.ts");
          return [first, second].map((answer) => offeredIn(answer).system);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(before).not.toContain(MENTIONS);
    expect(after).toContain(MENTIONS);
  });
});

describe("the programs the workspace section names", () => {
  it.each(["shell", "desktop"] as const)(
    "says a program runs through bash at Level %s",
    (level) => {
      const section = workspaceSection(level);

      expect(section).toContain(
        "run the `agent-browser` command with the bash tool"
      );
      expect(section).toContain("not a tool you can call");
    }
  );

  it("says the same of agent-desktop", () => {
    expect(workspaceSection("desktop")).toContain(
      "run the `agent-desktop` command with the bash tool"
    );
  });
});

const callMissingTool = (level: "none" | "shell", name: string) => {
  const { layer } = fauxAgents([
    callTool(name, { url: "https://example.com" }),
    echoToolResult,
  ]);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* agents.create({
          owner: alice.id,
          prompt: "",
          title: "",
          level,
          createdAt: 0,
        });
        const seat = yield* agents.open(id);
        return yield* seat.ask("Open example.com");
      })
    ).pipe(Effect.provide(layer))
  );
};

describe("a call to a tool that does not exist", () => {
  // A local model called `agent-browser open` as a tool, then read "not available" as "not installed" and gave up on
  // the browser.
  it("tells the model to run a program with bash, not that it is missing", async () => {
    const answer = await callMissingTool("shell", "agent-browser open");

    expect(answer).toContain("error:");
    expect(answer).toContain("agent-browser open");
    expect(answer).toContain("bash tool");
    expect(answer).not.toContain("is not available");
  });

  it("points to upgrade_workspace when there is no shell yet", async () => {
    const answer = await callMissingTool("none", "agent-browser");

    expect(answer).toContain("upgrade_workspace");
    expect(answer).not.toContain("bash tool");
  });
});

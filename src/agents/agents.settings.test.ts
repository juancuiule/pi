// A conversation's settings: what turning extensions, tools and skills on or off does to what the model is offered.
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { Skills } from "../skills/skills.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
} from "../testing/faux.ts";
import { Agents } from "./agents.ts";

const withSkills = { skills: Skills.directory("skills") };

const create = (
  options: Partial<Parameters<(typeof Agents)["Service"]["create"]>[0]> = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.create({
      prompt: "",
      title: "",
      level: "none",
      createdAt: 0,
      ...options,
    });
  });

describe("conversation settings", () => {
  it("offers the model only what is on, from its next request", async () => {
    const { layer } = fauxAgents([offered, offered], withSkills);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const before = offeredIn(yield* seat.ask("What do you have?"));
          const settings = yield* agents.configure(id, {
            extensions: { calculator: false },
            tools: { bash: false },
            skills: { "unit-conversion": false },
          });
          const after = offeredIn(yield* seat.ask("And now?"));
          return { before, after, settings };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(
      ["calculate", "bash"].map((name) => [
        result.before.tools.includes(name),
        result.after.tools.includes(name),
      ])
    ).toStrictEqual([
      [true, false],
      [true, false],
    ]);
    // The skill is gone from the skills section, and its switch is off.
    expect([
      result.before.system.includes("unit-conversion"),
      result.after.system.includes("unit-conversion"),
      result.settings.skills.find((s) => s.name === "unit-conversion")?.enabled,
    ]).toStrictEqual([true, false, false]);
  });

  it("creates a conversation with settings, and keeps them through an Upgrade", async () => {
    const { layer } = fauxAgents([offered], withSkills);

    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({
            level: "shell",
            settings: {
              tools: { write: false },
              skills: { "repo-report": false },
            },
          });
          const seat = yield* agents.open(id);
          yield* seat.upgrade("desktop");
          return {
            offered: offeredIn(yield* seat.ask("What do you have?")),
            settings: yield* agents.agent(id),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(after.offered.tools).toContain("desktop_click");
    expect(after.offered.tools).toContain("bash");
    expect(after.offered.tools).not.toContain("write");
    expect(
      after.settings.skills.find((s) => s.name === "repo-report")?.enabled
    ).toBeFalsy();
  });

  it("refuses what the Level does not allow and the locked tracing, changing nothing", async () => {
    const { layer } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create();
        const exits = yield* Effect.forEach(
          [{ "coding-tools": true }, { tracing: false }],
          (extensions) => Effect.exit(agents.configure(id, { extensions }))
        );
        return { exits, settings: yield* agents.agent(id) };
      }).pipe(Effect.provide(layer))
    );

    expect(result.exits.map((exit) => Exit.isFailure(exit))).toStrictEqual([
      true,
      true,
    ]);
    expect(JSON.stringify(result.exits)).toContain("needs a shell");
    expect(
      result.settings.extensions
        .filter((each) => each.enabled)
        .map((each) => each.name)
    ).toStrictEqual(["calculator", "workspace", "tracing"]);
  });

  it("approves the calls waiting for approval when the policy turns to auto", async () => {
    const { layer } = fauxAgents([
      callTool("bash", { command: "echo ran" }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell", approvals: "ask" });
          const seat = yield* agents.open(id);
          const asking = yield* Effect.forkChild(seat.ask("Run it."));
          for (
            let tries = 0;
            (yield* seat.pendingApprovals) === 0;
            tries += 1
          ) {
            if (tries > 300) {
              return yield* Effect.die(new Error("no call waited"));
            }
            yield* Effect.sleep("10 millis");
          }
          yield* agents.configure(id, { approvals: "auto" });
          return yield* Fiber.join(asking);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(answer).toContain("ran");
  });
});

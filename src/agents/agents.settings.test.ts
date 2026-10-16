// A conversation's settings: what turning extensions, tools and skills on or off does to what the model is offered.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect, Exit, Fiber, Layer, Stream, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
} from "../testing/faux.ts";
import { Agents } from "./agents.ts";
import { SETTINGS_ENTRY } from "./settings.ts";

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

/** The first event of a conversation's stream, its snapshot. */
const snapshotOf = (id: Parameters<(typeof Agents)["Service"]["open"]>[0]) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const events = yield* agents.events(id);
    const [first] = yield* events.pipe(Stream.take(1), Stream.runCollect);
    return first?.type === "snapshot" ? first : undefined;
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
          yield* seat.upgrade({ level: "desktop" });
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

  it("refuses what the Level does not allow and the locked extensions, changing nothing", async () => {
    const { layer } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create();
        const exits = yield* Effect.forEach(
          [
            { extensions: { "coding-tools": true } },
            { extensions: { tracing: false } },
            { extensions: { attachments: false } },
            { extensions: { artifacts: false } },
            { tools: { read_attachment: false } },
            { tools: { artifact_create: false } },
          ],
          (change) => Effect.exit(agents.configure(id, change))
        );
        return { exits, settings: yield* agents.agent(id) };
      }).pipe(Effect.provide(layer))
    );

    expect(result.exits.map((exit) => Exit.isFailure(exit))).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(JSON.stringify(result.exits)).toContain("needs a shell");
    expect(JSON.stringify(result.exits)).toContain("always on");
    expect(
      result.settings.extensions
        .filter((each) => each.enabled)
        .map((each) => each.name)
    ).toStrictEqual([
      "calculator",
      "workspace",
      "attachments",
      "artifacts",
      "questions",
      "tracing",
    ]);
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

  it("applies concurrent changes without one undoing the other", async () => {
    const { layer } = fauxAgents([]);

    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create({ level: "shell" });
        yield* Effect.all(
          [
            agents.configure(id, { tools: { bash: false } }),
            agents.configure(id, { tools: { write: false } }),
            agents.configure(id, { extensions: { calculator: false } }),
          ],
          { concurrency: "unbounded" }
        );
        return yield* agents.agent(id);
      }).pipe(Effect.provide(layer))
    );

    expect([
      settings.extensions.find((e) => e.name === "calculator")?.enabled,
      settings.extensions
        .flatMap((e) => e.tools)
        .filter((t) => !t.enabled)
        .map((t) => t.name)
        .toSorted(),
    ]).toStrictEqual([false, ["bash", "write"]]);
  });

  it("refuses a forced skill while the skills extension is off", async () => {
    const { layer } = fauxAgents([], withSkills);

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          yield* agents.configure(id, { extensions: { skills: false } });
          const seat = yield* agents.open(id);
          return yield* Effect.exit(seat.send("/skill:unit-conversion 3 km"));
        })
      ).pipe(Effect.provide(layer))
    );

    expect(JSON.stringify(exit)).toContain("SkillNotFound");
  });

  it("deletes a skill turned off from the Sandbox, and copies it back when turned on", async () => {
    const { layer } = fauxAgents([], withSkills);

    const present = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "unit-conversion"
          );
          const seen = [existsSync(folder)];
          yield* agents.configure(id, { skills: { "unit-conversion": false } });
          seen.push(existsSync(folder));
          yield* agents.configure(id, { skills: { "unit-conversion": true } });
          seen.push(existsSync(folder));
          return seen;
        })
      ).pipe(Effect.provide(layer))
    );

    expect(present).toStrictEqual([true, false, true]);
  });

  it("records each change in the conversation, a reset and the agent's Upgrade included", async () => {
    const { layer } = fauxAgents([
      callTool("upgrade_workspace", { level: "shell", reason: "to run code" }),
      echoToolResult,
    ]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ approvals: "ask" });
          yield* agents.configure(id, {
            approvals: "auto",
            tools: { calculate: false },
          });
          const reset = yield* agents.reset(id);
          const seat = yield* agents.open(id);
          yield* seat.ask("Get a shell.");
          const events = yield* agents.events(id);
          const [snapshot] = yield* events.pipe(
            Stream.take(1),
            Stream.runCollect
          );
          return {
            reset,
            records:
              snapshot?.type === "snapshot"
                ? snapshot.entries
                    .filter((entry) => entry.kind === SETTINGS_ENTRY)
                    .map((entry) => entry.data)
                : [],
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.records).toStrictEqual([
      {
        by: "person",
        reset: false,
        changes: [
          { type: "approvals", policy: "auto" },
          { type: "tool", name: "calculate", on: false },
        ],
      },
      {
        by: "person",
        reset: true,
        changes: [{ type: "tool", name: "calculate", on: true }],
      },
      {
        by: "agent",
        changes: [{ type: "level", from: "none", to: "shell" }],
      },
    ]);
    // A reset keeps the approval policy.
    expect(result.reset.approvals).toBe("auto");
  });

  it("puts a settings change on the conversation's Langfuse session", async () => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const { layer } = fauxAgents([]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create();
        yield* agents.configure(id, { tools: { calculate: false } });
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    );

    const span = spans.find((each) => each.name === "Agents.configure");
    expect([
      span?.attributes.get("langfuse.observation.type"),
      typeof span?.attributes.get("langfuse.session.id"),
      span?.attributes.get("langfuse.observation.output"),
    ]).toStrictEqual([
      "event",
      "string",
      JSON.stringify([{ type: "tool", name: "calculate", on: false }]),
    ]);
  });

  it("leaves the Sandbox matching the last of two opposite toggles sent at once", async () => {
    const { layer } = fauxAgents([], withSkills);

    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "unit-conversion"
          );
          return yield* Effect.forEach(Array.from({ length: 5 }), () =>
            Effect.gen(function* () {
              yield* Effect.all(
                [
                  agents.configure(id, {
                    skills: { "unit-conversion": false },
                  }),
                  agents.configure(id, { skills: { "unit-conversion": true } }),
                ],
                { concurrency: "unbounded" }
              );
              const settings = yield* agents.agent(id);
              const enabled =
                settings.skills.find((s) => s.name === "unit-conversion")
                  ?.enabled ?? false;
              return enabled === existsSync(folder);
            })
          );
        })
      ).pipe(Effect.provide(layer))
    );

    expect(outcomes).toStrictEqual([true, true, true, true, true]);
  });

  it("replaces stale skill files on reset, and repairs a missing copy on any later change", async () => {
    const { layer } = fauxAgents([], withSkills);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "unit-conversion"
          );
          // A stale extra file, and a missing one, as after a skill changed at its source.
          writeFileSync(path.join(folder, "stale.txt"), "old");
          rmSync(path.join(folder, "SKILL.md"));
          yield* agents.reset(id);
          const afterReset = [
            existsSync(path.join(folder, "stale.txt")),
            existsSync(path.join(folder, "SKILL.md")),
          ];
          // As after a copy that failed: the next change, even one about something else, makes it.
          rmSync(folder, { recursive: true });
          yield* agents.configure(id, { approvals: "auto" });
          return {
            afterReset,
            repaired: existsSync(path.join(folder, "SKILL.md")),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result).toStrictEqual({ afterReset: [false, true], repaired: true });
  });

  it("keeps a skill's working copy when its source loses a file, and deletes it once a reset drops the skill", async () => {
    // A source a test can change while the conversation runs.
    const files: Record<string, string> = {
      "alpha/SKILL.md":
        "---\nname: alpha\ndescription: Alpha.\n---\nDo alpha.\n",
      "alpha/scripts/run.sh": "echo alpha\n",
    };
    const { layer } = fauxAgents([], {
      skills: Skills.layer.pipe(Layer.provide(SkillSource.memory(files))),
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(seat.sandbox?.id ?? "", ".skills", "alpha");
          delete files["alpha/SKILL.md"];
          // An unrelated change keeps the copy: the source cannot supply the skill any more.
          yield* agents.configure(id, { approvals: "ask" });
          const kept = existsSync(path.join(folder, "SKILL.md"));
          // A reset takes the source as it is now, without alpha: its folder goes.
          const settings = yield* agents.reset(id);
          return {
            kept,
            listed: settings.skills.some((skill) => skill.name === "alpha"),
            deleted: !existsSync(folder),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result).toStrictEqual({ kept: true, listed: false, deleted: true });
  });

  it("moves a conversation off a model the server no longer has, and keeps the unanswered input", async () => {
    const dbFile = path.join(
      mkdtempSync(path.join(tmpdir(), "model-")),
      "db.sqlite"
    );
    // One Agents layer over the same database per server run, with its configured model.
    const run = <A, E>(
      model: { provider: string; modelId: string },
      program: Effect.Effect<A, E, Agents>
    ) =>
      Effect.promise(() => openNodeSqliteStorage(dbFile)).pipe(
        Effect.flatMap((storage) =>
          program.pipe(
            Effect.provide(
              fauxAgents([fauxAssistantMessage([fauxText("answered")])], {
                storage,
                model,
              }).layer
            )
          )
        )
      );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Created with a model this server does not have, and the configured one is missing too: no answer.
        const first = yield* run(
          { provider: "faux", modelId: "gone" },
          Effect.scoped(
            Effect.gen(function* () {
              const id = yield* create();
              const seat = yield* (yield* Agents).open(id);
              const failed = yield* Effect.exit(seat.ask("hello"));
              const snapshot = yield* snapshotOf(id);
              return { id, failed: Exit.isFailure(failed), snapshot };
            })
          )
        );
        // The next server has a model: opening the conversation moves it there.
        const second = yield* run(
          { provider: "faux", modelId: "faux-1" },
          Effect.scoped(
            Effect.gen(function* () {
              const agents = yield* Agents;
              const seat = yield* agents.open(first.id);
              const answer = yield* seat.ask("again");
              const { model } = yield* agents.agent(first.id);
              const snapshot = yield* snapshotOf(first.id);
              return { answer, model, snapshot };
            })
          )
        );
        return { first, second };
      })
    );

    const userEntry = result.first.snapshot?.entries.find(
      (entry) => entry.kind === "pi.user"
    )?.id;
    expect({
      failed: result.first.failed,
      unanswered: result.first.snapshot?.unanswered,
    }).toStrictEqual({
      failed: true,
      unanswered: [{ entry: userEntry, reason: "no_model" }],
    });
    expect({
      answer: result.second.answer,
      model: result.second.model,
      records: result.second.snapshot?.entries
        .filter((entry) => entry.kind === SETTINGS_ENTRY)
        .map((entry) => entry.data),
      unanswered: result.second.snapshot?.unanswered,
    }).toStrictEqual({
      answer: "answered",
      model: "faux/faux-1",
      records: [
        {
          by: "server",
          changes: [{ type: "model", from: "faux/gone", to: "faux/faux-1" }],
        },
      ],
      unanswered: [{ entry: userEntry, reason: "no_model" }],
    });
  });
});

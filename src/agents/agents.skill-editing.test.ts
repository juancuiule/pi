// The agent's own skill editing: `skill_save` and `skill_delete` write the org namespace through the same source
// conversations read, and the calling conversation's settings and Sandbox copies follow the write.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { approvalKey } from "../approvals.ts";
import { Skills, SkillSource, SkillSourceError } from "../skills/skills.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { alice } from "../testing/users.ts";
import { Agents } from "./agents.ts";
import { SETTINGS_ENTRY } from "./settings.ts";

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`;

const skillsOver = (files: Record<string, string>) =>
  Skills.layer.pipe(Layer.provide(SkillSource.memory(files)));

/** A source whose list starts failing once a write lands: the write is done, the follow-up read is not. */
const breakingAfterWrite = (files: Record<string, string>) =>
  Layer.effect(
    SkillSource,
    Effect.gen(function* () {
      const inner = yield* SkillSource;
      let broken = false;
      return SkillSource.of({
        ...inner,
        list: Effect.suspend(() =>
          broken
            ? Effect.fail(
                new SkillSourceError({ message: "the source flapped" })
              )
            : inner.list
        ),
        put: (id, putFiles) =>
          inner.put(id, putFiles).pipe(
            Effect.andThen(
              Effect.sync(() => {
                broken = true;
              })
            )
          ),
        remove: (id) =>
          inner.remove(id).pipe(
            Effect.andThen(
              Effect.sync(() => {
                broken = true;
              })
            )
          ),
      });
    })
  ).pipe(Layer.provide(SkillSource.memory(files)), (layer) =>
    Skills.layer.pipe(Layer.provide(layer))
  );

const create = (
  options: Partial<Parameters<(typeof Agents)["Service"]["create"]>[0]> = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.create({
      owner: alice.id,
      prompt: "",
      title: "",
      level: "none",
      createdAt: 0,
      ...options,
    });
  });

/** The settings records a conversation committed, as the console shows them. */
const recordsOf = (id: Parameters<(typeof Agents)["Service"]["open"]>[0]) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const events = yield* agents.events(id);
    const [first] = yield* events.pipe(Stream.take(1), Stream.runCollect);
    return first?.type === "snapshot"
      ? first.entries
          .filter((entry) => entry.kind === SETTINGS_ENTRY)
          .map((entry) => entry.data)
      : [];
  });

describe("skill_save and skill_delete", () => {
  it("writes a new skill and turns it on, recorded as the agent", async () => {
    const files: Record<string, string> = {};
    const { layer } = fauxAgents(
      [
        callTool("skill_save", {
          name: "pdf",
          files: { "SKILL.md": skillFile("pdf", "Work with PDFs.") },
          reason: "the user needs PDF help",
        }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          const seat = yield* agents.open(id);
          const answer = yield* seat.ask("Make a PDF skill.");
          const settings = yield* agents.agent(id);
          const records = yield* recordsOf(id);
          return { answer, settings, records };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.answer).toBe(
      `Saved new skill "pdf"; it's on in this conversation and in every new one.`
    );
    expect(files["org/pdf/SKILL.md"]).toContain("name: pdf");
    expect(
      result.settings.skills.find((skill) => skill.name === "pdf")?.enabled
    ).toBeTruthy();
    expect(result.records).toStrictEqual([
      {
        by: "agent",
        reset: false,
        changes: [{ type: "skill", name: "pdf", on: true }],
      },
    ]);
  });

  it("refreshes an enabled skill's sandbox copy when the agent edits it", async () => {
    const files: Record<string, string> = {
      "builtin/convert/SKILL.md": skillFile("convert", "Convert units."),
      "builtin/convert/data.txt": "v1",
    };
    const { layer } = fauxAgents(
      [
        callTool("skill_save", {
          name: "convert",
          files: {
            "SKILL.md": skillFile("convert", "Convert units, v2."),
            "data.txt": "v2",
          },
          reason: "update it",
        }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "convert"
          );
          const answer = yield* seat.ask("Update the convert skill.");
          return {
            answer,
            skill: readFileSync(path.join(folder, "SKILL.md"), "utf-8"),
            data: readFileSync(path.join(folder, "data.txt"), "utf-8"),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.answer).toBe(
      `Updated skill "convert"; this conversation's copy is refreshed. It overrides the built-in; skill_delete restores the built-in.`
    );
    expect(result.skill).toContain("v2");
    expect(result.data).toBe("v2");
  });

  it("editing a disabled skill leaves it off", async () => {
    const files: Record<string, string> = {
      "builtin/convert/SKILL.md": skillFile("convert", "Convert units."),
    };
    const { layer } = fauxAgents(
      [
        callTool("skill_save", {
          name: "convert",
          files: { "SKILL.md": skillFile("convert", "Convert units, v2.") },
          reason: "update it",
        }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          yield* agents.configure(id, { skills: { convert: false } });
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "convert"
          );
          const answer = yield* seat.ask("Update the convert skill.");
          const settings = yield* agents.agent(id);
          return {
            answer,
            enabled: settings.skills.find((skill) => skill.name === "convert")
              ?.enabled,
            copied: existsSync(folder),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.answer).toBe(
      `Updated skill "convert". It's off here; new conversations get it.`
    );
    expect(result.enabled).toBeFalsy();
    expect(result.copied).toBeFalsy();
  });

  it("deletes an enabled org skill and turns it off, recorded as the agent", async () => {
    const files: Record<string, string> = {
      "org/mine/SKILL.md": skillFile("mine", "Made for the org."),
    };
    const { layer } = fauxAgents(
      [
        callTool("skill_delete", { name: "mine", reason: "obsolete" }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          const seat = yield* agents.open(id);
          const answer = yield* seat.ask("Delete the mine skill.");
          const settings = yield* agents.agent(id);
          const records = yield* recordsOf(id);
          return { answer, settings, records };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.answer).toBe(
      `Deleted skill "mine"; it's off in this conversation.`
    );
    expect(files["org/mine/SKILL.md"]).toBeUndefined();
    expect(
      result.settings.skills.find((skill) => skill.name === "mine")
    ).toBeUndefined();
    expect(result.records).toStrictEqual([
      {
        by: "agent",
        reset: false,
        changes: [{ type: "skill", name: "mine", on: false }],
      },
    ]);
  });

  it("reverting an enabled shadowed skill restores the built-in copy", async () => {
    const files: Record<string, string> = {
      "builtin/convert/SKILL.md": skillFile("convert", "Convert units."),
      "org/convert/SKILL.md": skillFile("convert", "Org convert."),
    };
    const { layer } = fauxAgents(
      [
        callTool("skill_delete", { name: "convert", reason: "go back" }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "convert"
          );
          expect(
            readFileSync(path.join(folder, "SKILL.md"), "utf-8")
          ).toContain("Org convert.");
          const answer = yield* seat.ask("Revert convert.");
          return {
            answer,
            skill: readFileSync(path.join(folder, "SKILL.md"), "utf-8"),
            orgFileGone: files["org/convert/SKILL.md"] === undefined,
            stillOn:
              (yield* agents.agent(id)).skills.find(
                (skill) => skill.name === "convert"
              )?.enabled ?? false,
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result).toStrictEqual({
      answer: `Reverted "convert" to the built-in version; this conversation's copy is refreshed.`,
      skill: expect.stringContaining("Convert units."),
      orgFileGone: true,
      stillOn: true,
    });
  });

  it("waits for the person's decision under ask, then writes", async () => {
    const files: Record<string, string> = {};
    const { layer } = fauxAgents(
      [
        callTool("skill_save", {
          name: "pdf",
          files: { "SKILL.md": skillFile("pdf", "Work with PDFs.") },
          reason: "needed",
        }),
        echoToolResult,
      ],
      { skills: skillsOver(files) }
    );

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ approvals: "ask" });
          const seat = yield* agents.open(id);
          const asking = yield* Effect.forkChild(seat.ask("Save a skill."));
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
          // The write has not happened while the call waits.
          const parked = files["org/pdf/SKILL.md"];
          yield* seat.decide(approvalKey(id, "call-skill_save"), "approve");
          return { answer: yield* Fiber.join(asking), parked };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(answer.parked).toBeUndefined();
    expect(answer.answer).toContain(`Saved new skill "pdf"`);
    expect(files["org/pdf/SKILL.md"]).toContain("name: pdf");
  });

  it("resyncs a stale sandbox copy on a refreshSkills change", async () => {
    const files: Record<string, string> = {
      "builtin/convert/SKILL.md": skillFile("convert", "Convert units."),
    };
    const { layer } = fauxAgents([], { skills: skillsOver(files) });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "shell" });
          const seat = yield* agents.open(id);
          const folder = path.join(
            seat.sandbox?.id ?? "",
            ".skills",
            "convert"
          );
          // The source moved on; the conversation's copy is stale.
          files["builtin/convert/SKILL.md"] = skillFile(
            "convert",
            "Convert units, now with pints."
          );
          files["builtin/convert/added.md"] = "new reference";
          yield* agents.configure(id, { refreshSkills: "all" });
          return {
            skill: readFileSync(path.join(folder, "SKILL.md"), "utf-8"),
            added: existsSync(path.join(folder, "added.md")),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    // The new file arrived, so the refresh also picked up the source's new file list.
    expect(result.skill).toContain("pints");
    expect(result.added).toBeTruthy();
  });

  it("keeps the skills extension on when the last skill is turned off", async () => {
    const { layer } = fauxAgents([], {
      skills: skillsOver({
        "builtin/convert/SKILL.md": skillFile("convert", "Convert units."),
      }),
    });

    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create();
        yield* agents.configure(id, { skills: { convert: false } });
        return yield* agents.agent(id);
      }).pipe(Effect.provide(layer))
    );

    const extension = settings.extensions.find(
      (each) => each.name === "skills"
    );
    expect([
      extension?.enabled,
      extension?.tools.map((tool) => tool.name),
    ]).toStrictEqual([true, ["skill", "skill_save", "skill_delete"]]);
  });

  it("reports a saved skill even when the settings hook cannot follow", async () => {
    const files: Record<string, string> = {};
    const { layer } = fauxAgents(
      [
        callTool("skill_save", {
          name: "pdf",
          files: { "SKILL.md": skillFile("pdf", "Work with PDFs.") },
          reason: "needed",
        }),
        echoToolResult,
      ],
      { skills: breakingAfterWrite(files) }
    );

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          const seat = yield* agents.open(id);
          return yield* seat.ask("Save a PDF skill.");
        })
      ).pipe(Effect.provide(layer))
    );

    // The write landed; the model is told the copy went in, and that this conversation could not follow.
    expect(files["org/pdf/SKILL.md"]).toContain("name: pdf");
    expect(answer).toContain(`Saved new skill "pdf"`);
    expect(answer).toContain("This conversation's copy could not be updated:");
  });

  it("reports a deleted skill even when the settings hook cannot follow", async () => {
    const files: Record<string, string> = {
      "org/mine/SKILL.md": skillFile("mine", "Made for the org."),
    };
    const { layer } = fauxAgents(
      [
        callTool("skill_delete", { name: "mine", reason: "obsolete" }),
        echoToolResult,
      ],
      { skills: breakingAfterWrite(files) }
    );

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          const seat = yield* agents.open(id);
          return yield* seat.ask("Delete the mine skill.");
        })
      ).pipe(Effect.provide(layer))
    );

    expect(files["org/mine/SKILL.md"]).toBeUndefined();
    expect(answer).toContain(`Deleted skill "mine"`);
    expect(answer).toContain("This conversation's copy could not be updated:");
  });
});

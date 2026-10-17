import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ask,
  callTool,
  echoToolResult,
  fauxAgents,
  openSeat,
} from "../testing/faux.ts";
import { Skills, SkillSource } from "./skills.ts";

const skillFile = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;

const CONVERT = {
  "convert/SKILL.md": skillFile("convert", "Convert units."),
  "convert/references/factors.md": "mile → km: 1.609344",
  "convert/scripts/hello.sh": "#!/bin/sh\necho hello from the skill",
  "hidden/SKILL.md": skillFile(
    "hidden",
    "Only on request.",
    "disable-model-invocation: true\n"
  ),
};

const skillsFrom = (files: Record<string, string>) =>
  Skills.layer.pipe(Layer.provide(SkillSource.memory(files)));

const withSkills = <A, E>(
  files: Record<string, string>,
  run: (skills: Skills["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.service(Skills).pipe(
      Effect.flatMap(run),
      Effect.provide(skillsFrom(files))
    )
  );

describe("Skills.catalog", () => {
  it("loads valid skills with their files and reports the rest", async () => {
    const { skills, problems } = await withSkills(
      {
        ...CONVERT,
        "broken/SKILL.md": "---\nname: broken\n---\nNo description.",
        "twin/SKILL.md": skillFile("convert", "Same name."),
        "notes/README.md": "Not a skill: no SKILL.md.",
      },
      (service) => service.catalog
    );

    expect(
      skills.map(({ name, files, disableModelInvocation }) => ({
        name,
        files,
        disableModelInvocation,
      }))
    ).toStrictEqual([
      {
        name: "convert",
        files: ["SKILL.md", "references/factors.md", "scripts/hello.sh"],
        disableModelInvocation: false,
      },
      { name: "hidden", files: ["SKILL.md"], disableModelInvocation: true },
    ]);
    expect(problems).toStrictEqual([
      "broken: description: is required",
      "twin: another skill is already named convert",
    ]);
  });
});

const catalogOf = (dir: string) =>
  Effect.runPromise(
    Effect.service(Skills).pipe(
      Effect.flatMap((service) => service.catalog),
      Effect.provide(Skills.directory(dir))
    )
  );

describe("Skills.directory", () => {
  let root = "";
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads nested files and skips dotfiles", async () => {
    root = mkdtempSync(path.join(tmpdir(), "effect-pi-skills-"));
    for (const [file, contents] of Object.entries({
      ...CONVERT,
      "convert/.DS_Store": "",
      ".git/SKILL.md": skillFile("git", "Not a skill folder."),
    })) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }

    const { skills, problems } = await catalogOf(root);

    expect(skills.map((s) => [s.name, s.files])).toStrictEqual([
      ["convert", ["SKILL.md", "references/factors.md", "scripts/hello.sh"]],
      ["hidden", ["SKILL.md"]],
    ]);
    expect(problems).toStrictEqual([]);
  });

  it("has no skills when the folder is missing", async () => {
    await expect(
      catalogOf("/nonexistent/effect-pi-skills")
    ).resolves.toStrictEqual({
      skills: [],
      problems: [],
    });
  });

  it("loads the repository's own skills without problems", async () => {
    const { skills, problems } = await catalogOf("skills");

    expect({
      names: skills.map((skill) => skill.name),
      problems,
    }).toStrictEqual({
      names: ["desktop-notes", "diagrams", "repo-report", "unit-conversion"],
      problems: [],
    });
  });
});

const expand = (prompt: string) =>
  withSkills(CONVERT, (service) =>
    service.catalog.pipe(
      Effect.flatMap(({ skills }) => service.expand(prompt, skills))
    )
  );

describe("Skills.expand", () => {
  it("wraps a forced skill's instructions in a skill tag, followed by the request", async () => {
    const expanded = await expand("/skill:convert 3 mi to km");

    expect(expanded).toMatch(
      /^<skill name="convert">\nSkill "convert"\. Bundled files: references\/factors\.md, scripts\/hello\.sh\./u
    );
    expect(expanded).toMatch(/Do the thing\.\n<\/skill>\n\n3 mi to km$/u);
    await expect(expand("/skill:convert")).resolves.toMatch(
      /Do the thing\.\n<\/skill>$/u
    );
    await expect(expand("3 mi to km")).resolves.toBe("3 mi to km");
  });

  it("fails on an unknown forced skill", async () => {
    const error = await Effect.runPromise(
      Effect.service(Skills).pipe(
        Effect.flatMap((service) => service.expand("/skill:nope x", [])),
        Effect.flip,
        Effect.provide(skillsFrom(CONVERT))
      )
    );
    expect(error).toMatchObject({ _tag: "SkillNotFound", name: "nope" });
  });

  it("turns a mention in the middle of a prompt into a hint, keeping the prompt", async () => {
    await expect(
      expand(
        "How far is 3 mi? Maybe /skill:hidden or /skill:convert helps; /skill:nope is ignored."
      )
    ).resolves.toBe(
      [
        "How far is 3 mi? Maybe /skill:hidden or /skill:convert helps; /skill:nope is ignored.",
        "",
        "<skill_hints>",
        "  <note>The user pointed at these skills. Load one with the skill tool if it helps with the request.</note>",
        "  <skill>",
        "    <name>hidden</name>",
        "    <description>Only on request.</description>",
        "  </skill>",
        "  <skill>",
        "    <name>convert</name>",
        "    <description>Convert units.</description>",
        "  </skill>",
        "</skill_hints>",
      ].join("\n")
    );
    await expect(expand("Nothing /skill:nope here")).resolves.toBe(
      "Nothing /skill:nope here"
    );
  });

  it("hints at other skills mentioned in a forced skill's request", async () => {
    const expanded = await expand(
      "/skill:convert like /skill:hidden and /skill:convert"
    );

    expect(expanded).toMatch(
      /<\/skill>\n\nlike \/skill:hidden and \/skill:convert\n\n<skill_hints>\n {2}<note>[^\n]*\n {2}<skill>\n {4}<name>hidden<\/name>\n {4}<description>Only on request\.<\/description>\n {2}<\/skill>\n<\/skill_hints>$/u
    );
  });
});

const systemPrompt: FauxResponseFactory = (request) => {
  const system = request.messages.find((m) => m.role === "system");
  // pi-durable sends sections beside the system message's content; the provider assembles the prompt.
  return fauxAssistantMessage([fauxText(JSON.stringify(system))]);
};

describe("skills in a conversation", () => {
  const convert = skillsFrom(CONVERT);

  it("lists the skills the model may load in the system prompt", async () => {
    const { layer } = fauxAgents([systemPrompt], { skills: convert });

    const answer = await Effect.runPromise(
      ask("Which skills do you have?").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("<name>convert</name>");
    expect(answer).not.toContain("hidden");
  });

  it("has no skill tool or section without skills", async () => {
    const { layer } = fauxAgents([systemPrompt]);

    const answer = await Effect.runPromise(
      ask("Which skills do you have?").pipe(Effect.provide(layer))
    );

    expect(answer).not.toContain("available_skills");
  });

  it("loads a skill and then one of its files with the skill tool", async () => {
    const { layer } = fauxAgents(
      [
        callTool("skill", { name: "convert" }),
        callTool("skill", { name: "convert", file: "references/factors.md" }),
        echoToolResult,
      ],
      { skills: convert }
    );

    const answer = await Effect.runPromise(
      ask("Convert 3 miles to km.").pipe(Effect.provide(layer))
    );

    expect(answer).toBe("mile → km: 1.609344");
  });

  it("refuses files the skill does not bundle", async () => {
    const { layer } = fauxAgents(
      [
        callTool("skill", { name: "convert", file: "../hidden/SKILL.md" }),
        echoToolResult,
      ],
      { skills: convert }
    );

    const answer = await Effect.runPromise(
      ask("Read another skill's file.").pipe(Effect.provide(layer))
    );

    expect(answer).toMatch(/^error:[\s\S]*Skill convert has no file/u);
  });

  it("tells the model where the skill's folder is in the sandbox", async () => {
    const { layer } = fauxAgents(
      [callTool("skill", { name: "convert" }), echoToolResult],
      { skills: convert }
    );

    const answer = await Effect.runPromise(
      ask("Load the skill.", "shell").pipe(Effect.provide(layer))
    );

    // Local test sandboxes run in their Workspace's temporary directory.
    expect(answer).toMatch(
      /In your sandbox the folder is \/\S*effect-pi-workspace-\S*\/\.skills\/convert; run its scripts by full path, such as \S*\/\.skills\/convert\/scripts\/hello\.sh\./u
    );
  });

  it("copies skills into the sandbox so their scripts run there", async () => {
    const { layer } = fauxAgents(
      [
        callTool("bash", { command: ".skills/convert/scripts/hello.sh" }),
        echoToolResult,
      ],
      { skills: convert }
    );

    const answer = await Effect.runPromise(
      ask("Run the skill's script.", "shell").pipe(Effect.provide(layer))
    );

    expect(answer.trim()).toBe("hello from the skill");
  });

  it("keeps the skills a conversation started with when the source changes", async () => {
    // The memory source reads `files` on every call, like an S3 bucket or a database that changes.
    const files: Record<string, string> = { ...CONVERT };
    const { layer } = fauxAgents([systemPrompt, systemPrompt], {
      skills: skillsFrom(files),
    });

    const [before, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* openSeat({ sandbox: "none" });
          files["pdf/SKILL.md"] = skillFile("pdf", "Work with PDFs.");
          const second = yield* openSeat({ sandbox: "none" });
          return [yield* first.ask("Skills?"), yield* second.ask("Skills?")];
        })
      ).pipe(Effect.provide(layer))
    );

    expect(before).not.toContain("<name>pdf</name>");
    expect(after).toContain("<name>pdf</name>");
  });
});

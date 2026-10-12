import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  expandSkillCommand,
  loadSkills,
  parseSkillFile,
  validateFrontmatter,
} from "./skills.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

let root = "";
const removeSkillsDir = () => {
  rmSync(root, { recursive: true, force: true });
};

/** A skills folder with the given files, as `{ "<skill>/<path>": contents }`. */
const skillsDir = (files: Record<string, string>) => {
  root = mkdtempSync(path.join(tmpdir(), "effect-pi-skills-"));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
};

const skillFile = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;

describe(parseSkillFile, () => {
  it("splits the YAML frontmatter from the instructions", () => {
    expect(
      parseSkillFile("---\nname: a\ndescription: b\n---\n\n# A\n")
    ).toStrictEqual({
      frontmatter: { name: "a", description: "b" },
      body: "\n# A\n",
    });
  });
});

describe(validateFrontmatter, () => {
  it.for([
    [{ name: "pdf-tools", description: "Work with PDFs." }, []],
    [
      { name: "PDF", description: "x" },
      [
        "name must be lowercase letters, digits and single hyphens, not at either end",
      ],
    ],
    [
      { name: "a--b", description: "x" },
      [
        "name must be lowercase letters, digits and single hyphens, not at either end",
      ],
    ],
    [{ name: "ok" }, ["description is required"]],
    [undefined, ["no frontmatter"]],
  ] as const)("%j → %j", ([frontmatter, problems]) => {
    expect(validateFrontmatter(frontmatter)).toStrictEqual(problems);
  });
});

describe(loadSkills, () => {
  afterEach(removeSkillsDir);

  it("loads valid skills with their files and reports the rest", () => {
    const dir = skillsDir({
      "convert/SKILL.md": skillFile("convert", "Convert units."),
      "convert/references/factors.md": "| a | b |",
      "convert/scripts/run.sh": "echo hi",
      "hidden/SKILL.md": skillFile(
        "hidden",
        "Only on request.",
        "disable-model-invocation: true\n"
      ),
      "broken/SKILL.md": "---\nname: broken\n---\nNo description.",
      "notes/README.md": "Not a skill: no SKILL.md.",
    });

    const { skills, problems } = loadSkills(dir);

    expect(
      skills.map(({ name, files, disableModelInvocation }) => ({
        name,
        files,
        disableModelInvocation,
      }))
    ).toStrictEqual([
      {
        name: "convert",
        files: ["SKILL.md", "references/factors.md", "scripts/run.sh"],
        disableModelInvocation: false,
      },
      { name: "hidden", files: ["SKILL.md"], disableModelInvocation: true },
    ]);
    expect(problems).toStrictEqual(["broken: description is required"]);
  });

  it("loads the repository's own skills without problems", () => {
    const { skills, problems } = loadSkills("skills");

    expect({
      names: skills.map((skill) => skill.name),
      problems,
    }).toStrictEqual({
      names: ["desktop-notes", "repo-report", "unit-conversion"],
      problems: [],
    });
  });
});

describe(expandSkillCommand, () => {
  afterEach(removeSkillsDir);

  it("wraps the skill's instructions in a skill tag, followed by the request", () => {
    const { skills } = loadSkills(
      skillsDir({ "convert/SKILL.md": skillFile("convert", "Convert units.") })
    );

    const expanded = expandSkillCommand("/skill:convert 3 mi to km", skills);

    expect(expanded).toMatch(
      /^<skill name="convert">\nSkill "convert"\. It has no bundled files\./u
    );
    expect(expanded).toMatch(/Do the thing\.\n<\/skill>\n\n3 mi to km$/u);
    expect(expandSkillCommand("/skill:convert", skills)).toMatch(
      /Do the thing\.\n<\/skill>$/u
    );
    expect(expandSkillCommand("3 mi to km", skills)).toBe("3 mi to km");
    expect(() => expandSkillCommand("/skill:nope x", skills)).toThrow(
      "No skill named nope"
    );
  });
});

const convertSkill = () =>
  loadSkills(
    skillsDir({
      "convert/SKILL.md": skillFile("convert", "Convert units."),
      "convert/references/factors.md": "mile → km: 1.609344",
      "convert/scripts/hello.sh": "#!/bin/sh\necho hello from the skill",
      "hidden/SKILL.md": skillFile(
        "hidden",
        "Only on request.",
        "disable-model-invocation: true\n"
      ),
    })
  ).skills;

const systemPrompt: FauxResponseFactory = (request) => {
  const system = request.messages.find((m) => m.role === "system");
  // pi-durable sends sections beside the system message's content; the provider assembles the prompt.
  return fauxAssistantMessage([fauxText(JSON.stringify(system))]);
};

describe("skills in a conversation", () => {
  afterEach(removeSkillsDir);

  it("lists the skills the model may load in the system prompt", async () => {
    const { layer } = fauxAgents([systemPrompt], { skills: convertSkill() });

    const answer = await Effect.runPromise(
      ask("Which skills do you have?").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("<name>convert</name>");
    expect(answer).not.toContain("hidden");
  });

  it("loads a skill and then one of its files with the skill tool", async () => {
    const { layer } = fauxAgents(
      [
        callTool("skill", { name: "convert" }),
        callTool("skill", { name: "convert", file: "references/factors.md" }),
        echoToolResult,
      ],
      { skills: convertSkill() }
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
      { skills: convertSkill() }
    );

    const answer = await Effect.runPromise(
      ask("Read another skill's file.").pipe(Effect.provide(layer))
    );

    expect(answer).toMatch(/^error:[\s\S]*Skill convert has no file/u);
  });

  it("tells the model where the skill's folder is in the sandbox", async () => {
    const { layer } = fauxAgents(
      [callTool("skill", { name: "convert" }), echoToolResult],
      { skills: convertSkill() }
    );

    const answer = await Effect.runPromise(
      ask("Load the skill.", "shell").pipe(Effect.provide(layer))
    );

    // Local test sandboxes are temporary directories named after the sandbox.
    expect(answer).toMatch(
      /In your sandbox the folder is \/\S*effect-pi-shell-\S*\/\.skills\/convert; run its scripts by full path, such as \S*\/\.skills\/convert\/scripts\/hello\.sh\./u
    );
  });

  it("copies skills into the sandbox so their scripts run there", async () => {
    const { layer } = fauxAgents(
      [
        callTool("bash", { command: ".skills/convert/scripts/hello.sh" }),
        echoToolResult,
      ],
      { skills: convertSkill() }
    );

    const answer = await Effect.runPromise(
      ask("Run the skill's script.", "shell").pipe(Effect.provide(layer))
    );

    expect(answer.trim()).toBe("hello from the skill");
  });
});

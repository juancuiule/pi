import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeSkill, parseSkillFile, skillMentions } from "./format.ts";

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

const problem = (text: string) =>
  Effect.runPromise(
    decodeSkill({ id: "x", files: ["SKILL.md"] }, text).pipe(
      Effect.flip,
      Effect.map((error) => error.message)
    )
  );

describe(decodeSkill, () => {
  it("decodes a valid skill, trimming the description", async () => {
    const skill = await Effect.runPromise(
      decodeSkill(
        { id: "pdf", files: ["scripts/a.sh", "SKILL.md"] },
        "---\nname: pdf-tools\ndescription: '  Work with PDFs. '\ndisable-model-invocation: true\n---\n"
      )
    );
    expect(skill).toStrictEqual({
      name: "pdf-tools",
      description: "Work with PDFs.",
      id: "pdf",
      files: ["SKILL.md", "scripts/a.sh"],
      disableModelInvocation: true,
    });
  });

  it.for([
    [
      "---\nname: PDF\ndescription: x\n---\n",
      "name: must be lowercase letters, digits and single hyphens, not at either end",
    ],
    [
      "---\nname: a--b\ndescription: x\n---\n",
      "name: must be lowercase letters, digits and single hyphens, not at either end",
    ],
    ["---\nname: ok\n---\n", "description: is required"],
    ["---\nname: ok\ndescription: '  '\n---\n", "description: is required"],
    [
      "---\nname: 3\ndisable-model-invocation: yes\n---\n",
      "name: Expected string; description: is required; disable-model-invocation: Expected boolean",
    ],
    ["# No frontmatter", "no frontmatter"],
    ["---\nname: [\n---\n", "invalid frontmatter"],
  ] as const)("%j → %s", async ([text, expected]) => {
    await expect(problem(text)).resolves.toContain(expected);
  });
});

describe(skillMentions, () => {
  it("finds /skill:<name> after whitespace, once each", () => {
    expect(
      skillMentions(
        "/skill:first then /skill:convert, and\n/skill:pdf-tools. Again /skill:convert"
      )
    ).toStrictEqual(["first", "convert", "pdf-tools"]);
  });

  it("ignores names glued to other text", () => {
    expect(
      skillMentions("see a/skill:x or /skill:Upper or /skill:x_y")
    ).toStrictEqual([]);
  });
});

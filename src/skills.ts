// Agent Skills (https://agentskills.io/specification), the way pi's coding agent uses them: each skill is a folder
// with a SKILL.md whose frontmatter names and describes it. The system prompt lists only names and descriptions; the
// model loads a skill's instructions, and any bundled file, when a task calls for it. Here it loads them with the
// `skill` tool, which reads from the host and so works without a sandbox, and sandboxed conversations also get a copy
// of every skill at `.skills/<name>/`, so bundled scripts can run there.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { parse as parseYaml } from "yaml";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_FILE = "SKILL.md";

/** Where sandboxed conversations find their skills, relative to the sandbox's working directory. */
export const SANDBOX_SKILLS_DIR = ".skills";

export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The skill's folder on the host. */
  readonly dir: string;
  /** Every file in the folder, relative to it, `SKILL.md` first. */
  readonly files: readonly string[];
  /** Hidden from the model's list; loaded only through `/skill:<name>`. */
  readonly disableModelInvocation: boolean;
}

export interface LoadedSkills {
  readonly skills: readonly Skill[];
  /** Why a folder was skipped, for example a missing description. */
  readonly problems: readonly string[];
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The frontmatter and body of a SKILL.md; `undefined` frontmatter when it has none. */
export const parseSkillFile = (
  text: string
): { readonly frontmatter: unknown; readonly body: string } => {
  const match =
    /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/u.exec(text);
  if (match?.groups === undefined) {
    return { frontmatter: undefined, body: text };
  }
  return {
    frontmatter: parseYaml(match.groups.yaml ?? ""),
    body: match.groups.body ?? "",
  };
};

/** Problems with a skill's frontmatter under the Agent Skills specification; empty when valid. */
export const validateFrontmatter = (frontmatter: unknown): string[] => {
  if (typeof frontmatter !== "object" || frontmatter === null) {
    return ["no frontmatter"];
  }
  const { name, description } = frontmatter as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof name !== "string" || name === "") {
    problems.push("name is required");
  } else {
    if (name.length > MAX_NAME_LENGTH) {
      problems.push(`name is longer than ${MAX_NAME_LENGTH} characters`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      problems.push(
        "name must be lowercase letters, digits and single hyphens, not at either end"
      );
    }
  }
  if (typeof description !== "string" || description.trim() === "") {
    problems.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(
      `description is longer than ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }
  return problems;
};

const listFiles = (dir: string, prefix = ""): string[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.name.startsWith(".")) {
        return [];
      }
      return entry.isDirectory() ? listFiles(dir, relative) : [relative];
    }
  );

/** Load every skill in `root`: each folder with a SKILL.md. A missing `root` has no skills. */
export const loadSkills = (root: string): LoadedSkills => {
  let entries: string[];
  try {
    entries = readdirSync(root).toSorted();
  } catch {
    return { skills: [], problems: [] };
  }
  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const file = path.join(dir, SKILL_FILE);
    let text: string;
    try {
      if (!statSync(dir).isDirectory()) {
        continue;
      }
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let frontmatter: unknown;
    try {
      ({ frontmatter } = parseSkillFile(text));
    } catch (error) {
      problems.push(`${entry}: invalid frontmatter: ${String(error)}`);
      continue;
    }
    const invalid = validateFrontmatter(frontmatter);
    if (invalid.length > 0) {
      problems.push(`${entry}: ${invalid.join("; ")}`);
      continue;
    }
    const fields = frontmatter as Record<string, unknown>;
    const name = fields.name as string;
    if (skills.some((skill) => skill.name === name)) {
      problems.push(`${entry}: another skill is already named ${name}`);
      continue;
    }
    skills.push({
      name,
      description: (fields.description as string).trim(),
      dir,
      files: [
        SKILL_FILE,
        ...listFiles(dir)
          .filter((f) => f !== SKILL_FILE)
          .toSorted(),
      ],
      disableModelInvocation: fields["disable-model-invocation"] === true,
    });
  }
  return { skills, problems };
};

// ─── Reading a skill ─────────────────────────────────────────────────────────

/**
 * What the `skill` tool returns: a bundled file, or SKILL.md with a header listing the other files. Paths in a skill
 * are relative to its folder; `sandboxDir` is that folder's absolute path in the sandbox, when there is one, so the
 * model can run bundled scripts by full path.
 */
export const readSkill = (
  skill: Skill,
  file?: string,
  sandboxDir?: string
): string => {
  if (file !== undefined && file !== SKILL_FILE) {
    const relative = path.posix.normalize(file);
    if (!skill.files.includes(relative)) {
      throw new Error(
        `Skill ${skill.name} has no file ${file}. Its files: ${skill.files.join(", ")}`
      );
    }
    return readFileSync(path.join(skill.dir, relative), "utf-8");
  }
  const others = skill.files.filter((f) => f !== SKILL_FILE);
  const script = others.find((f) => f.startsWith("scripts/"));
  const header = [
    `Skill "${skill.name}".`,
    others.length === 0
      ? "It has no bundled files."
      : `Bundled files: ${others.join(", ")}. Paths in the skill are relative to its folder. Load a file with the skill tool and its \`file\` argument.`,
    ...(sandboxDir !== undefined && others.length > 0
      ? [
          `In your sandbox the folder is ${sandboxDir}; run its scripts by full path${script === undefined ? "" : `, such as ${sandboxDir}/${script}`}.`,
        ]
      : []),
  ].join(" ");
  return `${header}\n\n${readFileSync(path.join(skill.dir, SKILL_FILE), "utf-8")}`;
};

/** The system prompt section listing the skills the model may load on its own. */
export const skillsSection = (skills: readonly Skill[]): string | undefined => {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) {
    return;
  }
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "When a task matches a skill's description, load the skill with the skill tool before starting, then follow its instructions.",
    "",
    "<available_skills>",
    ...visible.map(
      (skill) =>
        `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`
    ),
    "</available_skills>",
  ].join("\n");
};

/** The `skill` tool and the section listing the skills. */
export const skillsExtension = (skills: readonly Skill[]): Extension =>
  defineExtension({
    name: "skills",
    sections: [section("skills", () => skillsSection(skills))],
    tools: [
      defineTool({
        name: "skill",
        description:
          "Load a skill's instructions (SKILL.md), or one of the files it bundles, by the skill's name.",
        parameters: Type.Object({
          name: Type.String({ description: "The skill's name" }),
          file: Type.Optional(
            Type.String({
              description:
                "A bundled file, relative to the skill, such as references/guide.md; omit for SKILL.md",
            })
          ),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const skill = skills.find((s) => s.name === args.name);
          if (skill === undefined) {
            throw new Error(
              `No skill named ${args.name}. Skills: ${skills.map((s) => s.name).join(", ")}`
            );
          }
          const sandboxDir = await api.env?.absolutePath(
            path.posix.join(SANDBOX_SKILLS_DIR, skill.name),
            context
          );
          const text = readSkill(
            skill,
            args.file,
            sandboxDir?.ok === true ? sandboxDir.value : undefined
          );
          return { content: [{ type: "text" as const, text }] };
        },
      }),
    ],
  });

/** `/skill:<name> <request>`: the skill's name and the request (possibly empty); `undefined` for any other prompt. */
export const parseSkillCommand = (
  prompt: string
): { readonly name: string; readonly request: string } | undefined => {
  const match =
    /^\/skill:(?<name>[a-z0-9-]+)(?:\s+(?<request>[\s\S]*))?$/u.exec(
      prompt.trim()
    );
  if (match?.groups?.name === undefined) {
    return;
  }
  return {
    name: match.groups.name,
    request: (match.groups.request ?? "").trim(),
  };
};

/**
 * The message a forced skill becomes: its instructions in a `<skill name="…">` block, then the request. The web
 * console recognizes the block and shows it as a chip (`web/lib/skill-message.ts`).
 */
export const formatSkillMessage = (skill: Skill, request: string): string => {
  const block = `<skill name="${skill.name}">\n${readSkill(skill).trimEnd()}\n</skill>`;
  return request === "" ? block : `${block}\n\n${request}`;
};

/** `/skill:<name> <request>` forces that skill (see `formatSkillMessage`); any other prompt is returned as is. */
export const expandSkillCommand = (
  prompt: string,
  skills: readonly Skill[]
): string => {
  const command = parseSkillCommand(prompt);
  if (command === undefined) {
    return prompt;
  }
  const skill = skills.find((s) => s.name === command.name);
  if (skill === undefined) {
    throw new Error(
      `No skill named ${command.name}. Skills: ${skills.map((s) => s.name).join(", ")}`
    );
  }
  return formatSkillMessage(skill, command.request);
};

// ─── Copying skills into a sandbox ───────────────────────────────────────────

const check = (result: {
  readonly ok: boolean;
  readonly error?: { readonly message: string };
}) => {
  if (!result.ok) {
    throw new Error(`Could not copy skills: ${result.error?.message}`);
  }
};

/** Copy every skill into the sandbox at `.skills/<name>/`, keeping scripts executable. */
export const installSkills = async (
  env: ExecutionEnv,
  skills: readonly Skill[],
  context: Context
): Promise<void> => {
  const files = skills.flatMap((skill) =>
    skill.files.map((file) => ({
      source: path.join(skill.dir, file),
      target: path.posix.join(SANDBOX_SKILLS_DIR, skill.name, file),
    }))
  );
  await Promise.all(
    files.map(async ({ source, target }) => {
      check(
        await env.createDir(
          path.posix.dirname(target),
          { recursive: true },
          context
        )
      );
      check(await env.writeFile(target, readFileSync(source), context));
    })
  );
  if (files.length > 0) {
    // Scripts lose their mode in the copy.
    check(
      await env.exec(
        `find ${SANDBOX_SKILLS_DIR} -path '*/scripts/*' -type f -exec chmod +x {} +`,
        {},
        context
      )
    );
  }
};

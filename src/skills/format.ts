// The text side of skills, with no I/O: SKILL.md frontmatter, what the `skill` tool returns, the system prompt
// section, and what `/skill:<name>` in a prompt becomes.
import { Effect, Schema, SchemaIssue } from "effect";
import { parse as parseYaml } from "yaml";

import { InvalidSkill } from "../errors.ts";
import { toXml } from "../prompt/xml.ts";
import type { SkillOrigin } from "./source.ts";

export { InvalidSkill } from "../errors.ts";

export const SKILL_FILE = "SKILL.md";

/** A folder's file path: `/`-joined segments of plain names — no `.`-names (list skips them), `..`, empties or `\`. */
export const isSkillFile = (file: string): boolean =>
  file
    .split("/")
    .every(
      (segment) =>
        segment !== "" && !segment.startsWith(".") && !segment.includes("\\")
    );

// The name rule, also checked on the wire in src/server/api.ts, which cannot import this module.
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** A SKILL.md frontmatter under the Agent Skills specification. */
export const SkillFrontmatter = Schema.Struct({
  name: Schema.String.check(
    Schema.isMaxLength(64, { message: "is longer than 64 characters" }),
    Schema.isPattern(SKILL_NAME, {
      message:
        "must be lowercase letters, digits and single hyphens, not at either end",
    })
  ).annotateKey({ messageMissingKey: "is required" }),
  description: Schema.Trim.check(
    Schema.isNonEmpty({ message: "is required" }),
    Schema.isMaxLength(1024, {
      message: "is longer than 1024 characters",
    })
  ).annotateKey({ messageMissingKey: "is required" }),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
}).annotate({ expected: "frontmatter" });

/** A loaded skill. Plain data, so a conversation can record the skills it started with. */
// A type, not an interface: conversations store it in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type Skill = {
  readonly name: string;
  readonly description: string;
  /** The skill's folder in its `SkillSource`. */
  readonly id: string;
  /** Every file in the folder, relative to it, `SKILL.md` first. */
  readonly files: string[];
  /** Hidden from the model's list; loaded only through `/skill:<name>`. */
  readonly disableModelInvocation: boolean;
  /** Which namespace the folder's listed copy comes from. */
  readonly origin?: SkillOrigin;
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

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

/** The skill a folder's SKILL.md describes, or why it is not one. */
export const decodeSkill = Effect.fnUntraced(function* (
  folder: {
    readonly id: string;
    readonly files: readonly string[];
    readonly origin?: SkillOrigin;
  },
  text: string
) {
  const frontmatter = yield* Effect.try({
    try: () => parseSkillFile(text).frontmatter,
    catch: (error) =>
      new InvalidSkill({ message: `invalid frontmatter: ${String(error)}` }),
  });
  if (frontmatter === undefined || frontmatter === null) {
    return yield* new InvalidSkill({ message: "no frontmatter" });
  }
  const fields = yield* Schema.decodeUnknownEffect(SkillFrontmatter)(
    frontmatter,
    { errors: "all" }
  ).pipe(
    Effect.mapError(
      (error) =>
        new InvalidSkill({
          message: formatIssues(error.issue)
            .issues.map(
              (issue) => `${(issue.path ?? []).join(".")}: ${issue.message}`
            )
            .join("; "),
        })
    )
  );
  return {
    name: fields.name,
    description: fields.description,
    id: folder.id,
    files: [
      SKILL_FILE,
      ...folder.files.filter((file) => file !== SKILL_FILE).toSorted(),
    ],
    disableModelInvocation: fields["disable-model-invocation"] ?? false,
    ...(folder.origin === undefined ? {} : { origin: folder.origin }),
  } satisfies Skill;
});

/** A skill's folder caps at 50 files of 256 KiB each, so one write cannot flood the shared source. */
const MAX_SKILL_FILES = 50;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fileSize = (contents: string | Uint8Array) =>
  typeof contents === "string"
    ? encoder.encode(contents).byteLength
    : contents.byteLength;

/**
 * Everything a folder of `files` must pass before it may be written as skill `id`: a non-empty, bounded file
 * list of valid paths, a SKILL.md whose frontmatter decodes and names `id` (which is therefore a valid skill
 * name), and `id` not naming a source namespace. `Skills.save` and the skills API validate with this before
 * anything is written.
 */
export const checkSkillFiles = (
  id: string,
  files: Readonly<Record<string, string | Uint8Array>>
): Effect.Effect<Skill, InvalidSkill> =>
  Effect.gen(function* () {
    const fileNames = Object.keys(files);
    if (fileNames.length === 0) {
      return yield* new InvalidSkill({ message: "files is empty" });
    }
    // `org` and `builtin` collide with the source's namespaces.
    if (id === "org" || id === "builtin") {
      return yield* new InvalidSkill({
        message: `${id} is a reserved skill name`,
      });
    }
    if (fileNames.length > MAX_SKILL_FILES) {
      return yield* new InvalidSkill({
        message: `a skill may have at most ${MAX_SKILL_FILES} files`,
      });
    }
    for (const file of fileNames) {
      if (!isSkillFile(file)) {
        return yield* new InvalidSkill({
          message: `${file} is not a valid skill file path`,
        });
      }
      if (fileSize(files[file] ?? "") > MAX_SKILL_FILE_BYTES) {
        return yield* new InvalidSkill({
          message: `${file} is over the 256 KiB file limit`,
        });
      }
    }
    const contents = files[SKILL_FILE];
    if (contents === undefined) {
      return yield* new InvalidSkill({
        message: `files must include ${SKILL_FILE}`,
      });
    }
    const skill = yield* decodeSkill(
      { id, files: fileNames },
      typeof contents === "string" ? contents : decoder.decode(contents)
    );
    if (skill.name !== id) {
      return yield* new InvalidSkill({
        message: `${SKILL_FILE} names ${skill.name}, not ${id}`,
      });
    }
    return skill;
  });

/**
 * What the `skill` tool returns for SKILL.md: a header listing the other files, then the file. Paths in a skill are
 * relative to its folder; `sandboxDir` is that folder's absolute path in the sandbox, when there is one, so the model
 * can run bundled scripts by full path.
 */
export const skillInstructions = (
  skill: Skill,
  text: string,
  sandboxDir?: string
): string => {
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
  return `${header}\n\n${text}`;
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
    toXml({
      available_skills: {
        skill: visible.map(({ name, description }) => ({ name, description })),
      },
    }),
  ].join("\n");
};

// ─── /skill: in a prompt ─────────────────────────────────────────────────────

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

/** The names of the `/skill:<name>` mentions in `text`, in order, without repeats. A mention follows whitespace. */
export const skillMentions = (text: string): readonly string[] => [
  ...new Set(
    Array.from(
      text.matchAll(
        /(?<=^|\s)\/skill:(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/gu
      ),
      (match) => match.groups?.name ?? ""
    )
  ),
];

/**
 * The message a forced skill becomes: its instructions in a `<skill name="…">` block, then the request. The web
 * console recognizes the block and shows it as a chip (`web/lib/skill-message.ts`).
 */
export const formatSkillMessage = (
  skill: Skill,
  instructions: string,
  request: string
): string => {
  const block = `<skill name="${skill.name}">\n${instructions.trimEnd()}\n</skill>`;
  return request === "" ? block : `${block}\n\n${request}`;
};

/**
 * Appended to a prompt that mentions skills: the model gets their descriptions and is told it may load them, without
 * being made to. The web console strips the block and shows the mentions as chips (`web/lib/skill-message.ts`).
 */
export const formatSkillHints = (skills: readonly Skill[]): string =>
  toXml({
    skill_hints: {
      note: "The user pointed at these skills. Load one with the skill tool if it helps with the request.",
      skill: skills.map(({ name, description }) => ({ name, description })),
    },
  });

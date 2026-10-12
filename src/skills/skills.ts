// Agent Skills (https://agentskills.io/specification), the way pi's coding agent uses them: each skill is a folder
// with a SKILL.md whose frontmatter names and describes it. The system prompt lists only names and descriptions; the
// model loads a skill's instructions, and any bundled file, when a task calls for it. Here it loads them with the
// `skill` tool, which reads from the `SkillSource` and so works without a sandbox, and sandboxed conversations also
// get a copy of every skill at `.skills/<name>/`, so bundled scripts can run there.
//
// The source is read again for every new conversation, which records the skills it started with in its `SkillsDoc`;
// a skill added to the source later shows up in the next conversation, not in running ones.
import path from "node:path";

import type { Context as ChordContext } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentReader,
  Extension,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";

import { SkillNotFound } from "../errors.ts";
import {
  decodeSkill,
  formatSkillHints,
  formatSkillMessage,
  parseSkillCommand,
  SKILL_FILE,
  skillInstructions,
  skillMentions,
  skillsSection,
} from "./format.ts";
import type { Skill } from "./format.ts";
import { SkillSource } from "./source.ts";
import type { SkillSourceError } from "./source.ts";

export type { Skill } from "./format.ts";
export { SkillSource, SkillSourceError } from "./source.ts";

/** Where sandboxed conversations find their skills, relative to the sandbox's working directory. */
export const SANDBOX_SKILLS_DIR = ".skills";

export interface SkillCatalog {
  readonly skills: readonly Skill[];
  /** Why a folder was skipped, for example a missing description. */
  readonly problems: readonly string[];
}

export class SkillFileNotFound extends Schema.TaggedError<SkillFileNotFound>()(
  "SkillFileNotFound",
  { message: Schema.String }
) {}

export class SkillInstallError extends Schema.TaggedError<SkillInstallError>()(
  "SkillInstallError",
  { message: Schema.String }
) {}

/** The skills a conversation started with. Subagents get their owner's; a fork keeps its parent's. */
export const SkillsDoc = defineDoc<{ skills?: Skill[] }>({
  kind: "app.skills",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

const notFound = (name: string, skills: readonly Skill[]) =>
  new SkillNotFound({ name, available: skills.map((s) => s.name) });

/** Run one `ExecutionEnv` call, failing with `what` when it rejects or reports an error. */
const envCall = <A extends { readonly ok: boolean }>(
  what: string,
  run: () => Promise<A & { readonly error?: { readonly message: string } }>
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SkillInstallError({ message: `${what}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.void
        : Effect.fail(
            new SkillInstallError({
              message: `${what}: ${result.error?.message}`,
            })
          )
    )
  );

export class Skills extends Context.Service<
  Skills,
  {
    /** The source's skills now: every folder with a valid SKILL.md, and why the others were skipped. */
    readonly catalog: Effect.Effect<SkillCatalog, SkillSourceError>;
    /**
     * What the `skill` tool returns: a bundled file, or SKILL.md with a header listing the other files. `sandboxDir`
     * is the skill's folder in the sandbox, when there is one.
     */
    readonly read: (
      skill: Skill,
      file?: string,
      sandboxDir?: string
    ) => Effect.Effect<string, SkillSourceError | SkillFileNotFound>;
    /**
     * `/skill:<name> <request>` forces that skill: its instructions go in the message (see `formatSkillMessage`).
     * `/skill:<name>` anywhere else is a hint: the message keeps it and gains a `<skill_hints>` block with the
     * skill's description. Unknown names fail when forced and are left alone when mentioned.
     */
    readonly expand: (
      prompt: string,
      skills: readonly Skill[]
    ) => Effect.Effect<string, SkillNotFound | SkillSourceError>;
    /** Copy the skills into the sandbox at `.skills/<name>/`, keeping scripts executable. */
    readonly install: (
      env: ExecutionEnv,
      skills: readonly Skill[],
      context: ChordContext
    ) => Effect.Effect<void, SkillSourceError | SkillInstallError>;
  }
>()("effect-pi/skills/Skills") {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const source = yield* SkillSource;
      const decoder = new TextDecoder();
      const readText = (id: string, file: string) =>
        source
          .read(id, file)
          .pipe(Effect.map((bytes) => decoder.decode(bytes)));

      const catalog = Effect.gen(function* () {
        const skills: Skill[] = [];
        const problems: string[] = [];
        for (const folder of yield* source.list) {
          if (!folder.files.includes(SKILL_FILE)) {
            continue;
          }
          const decoded = yield* Effect.result(
            decodeSkill(folder, yield* readText(folder.id, SKILL_FILE))
          );
          if (decoded._tag === "Failure") {
            problems.push(`${folder.id}: ${decoded.failure.message}`);
          } else if (skills.some((s) => s.name === decoded.success.name)) {
            problems.push(
              `${folder.id}: another skill is already named ${decoded.success.name}`
            );
          } else {
            skills.push(decoded.success);
          }
        }
        return { skills, problems };
      });

      const read = Effect.fnUntraced(function* (
        skill: Skill,
        file?: string,
        sandboxDir?: string
      ) {
        if (file !== undefined && file !== SKILL_FILE) {
          const relative = path.posix.normalize(file);
          if (!skill.files.includes(relative)) {
            return yield* new SkillFileNotFound({
              message: `Skill ${skill.name} has no file ${file}. Its files: ${skill.files.join(", ")}`,
            });
          }
          return yield* readText(skill.id, relative);
        }
        return skillInstructions(
          skill,
          yield* readText(skill.id, SKILL_FILE),
          sandboxDir
        );
      });

      const expand = Effect.fnUntraced(function* (
        prompt: string,
        skills: readonly Skill[]
      ) {
        const command = parseSkillCommand(prompt);
        let message = prompt;
        let forced: Skill | undefined;
        if (command !== undefined) {
          forced = skills.find((s) => s.name === command.name);
          if (forced === undefined) {
            return yield* notFound(command.name, skills);
          }
          const instructions = yield* read(forced).pipe(
            Effect.catchTag("SkillFileNotFound", Effect.die)
          );
          message = formatSkillMessage(forced, instructions, command.request);
        }
        const hinted = skillMentions(command?.request ?? prompt).flatMap(
          (name) => {
            const skill = skills.find((s) => s.name === name);
            return skill === undefined || skill === forced ? [] : [skill];
          }
        );
        return hinted.length === 0
          ? message
          : `${message}\n\n${formatSkillHints(hinted)}`;
      });

      const install = Effect.fnUntraced(function* (
        env: ExecutionEnv,
        skills: readonly Skill[],
        context: ChordContext
      ) {
        const files = skills.flatMap((skill) =>
          skill.files.map((file) => ({ skill, file }))
        );
        yield* Effect.forEach(
          files,
          ({ skill, file }) =>
            Effect.gen(function* () {
              const target = path.posix.join(
                SANDBOX_SKILLS_DIR,
                skill.name,
                file
              );
              const contents = yield* source.read(skill.id, file);
              yield* envCall(
                `Could not create ${path.posix.dirname(target)}`,
                () =>
                  env.createDir(
                    path.posix.dirname(target),
                    { recursive: true },
                    context
                  )
              );
              yield* envCall(`Could not write ${target}`, () =>
                env.writeFile(target, contents, context)
              );
            }),
          { concurrency: 16, discard: true }
        );
        if (files.length > 0) {
          // Scripts lose their mode in the copy.
          yield* envCall("Could not make skill scripts executable", () =>
            env.exec(
              `find ${SANDBOX_SKILLS_DIR} -path '*/scripts/*' -type f -exec chmod +x {} +`,
              {},
              context
            )
          );
        }
      });

      return Skills.of({ catalog, read, expand, install });
    })
  );

  /** Skills from folders under `root` on the host. */
  static readonly directory = (root: string) =>
    Skills.layer.pipe(
      Layer.provide(SkillSource.directory(root)),
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
    );

  /** No skills. */
  static readonly none = Skills.layer.pipe(
    Layer.provide(SkillSource.memory({}))
  );
}

/**
 * The `skill` tool and the section listing the skills, both reading the conversation's `SkillsDoc`. A conversation
 * stored before skills were recorded falls back to the current catalog.
 */
export const skillsExtension = (skills: Skills["Service"]): Extension => {
  const conversationSkills = async (
    reader: DocumentReader,
    conversationId: ConversationId,
    context: ChordContext
  ): Promise<readonly Skill[]> => {
    const doc = await reader.snapshot(SkillsDoc, conversationId, context);
    return (
      doc?.skills ??
      (await Effect.runPromise(
        skills.catalog.pipe(Effect.map((c) => c.skills))
      ))
    );
  };
  return defineExtension({
    name: "skills",
    sections: [
      section("skills", async (input, context) =>
        skillsSection(
          await conversationSkills(input.read, input.conversationId, context)
        )
      ),
    ],
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
          const available = await conversationSkills(
            api,
            api.conversationId,
            context
          );
          const skill = available.find((s) => s.name === args.name);
          if (skill === undefined) {
            throw new Error(
              `No skill named ${args.name}. Skills: ${available.map((s) => s.name).join(", ")}`
            );
          }
          const sandboxDir = await api.env?.absolutePath(
            path.posix.join(SANDBOX_SKILLS_DIR, skill.name),
            context
          );
          const text = await Effect.runPromise(
            skills.read(
              skill,
              args.file,
              sandboxDir?.ok === true ? sandboxDir.value : undefined
            )
          );
          return { content: [{ type: "text" as const, text }] };
        },
      }),
    ],
  });
};

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
import type { InvalidSkill } from "../errors.ts";
import {
  checkSkillFiles,
  decodeSkill,
  formatSkillHints,
  formatSkillMessage,
  parseSkillCommand,
  parseSkillFile,
  SKILL_FILE,
  skillInstructions,
  skillMentions,
  skillsSection,
} from "./format.ts";
import type { Skill } from "./format.ts";
import { SkillSource } from "./source.ts";
import type { SkillOrigin, SkillSourceError } from "./source.ts";

export type { Skill } from "./format.ts";
export type { SkillOrigin } from "./source.ts";
export { SkillSource, SkillSourceError } from "./source.ts";

/** What writing a skill's org folder did: created it, replaced the org copy, or shadowed a builtin one. */
export type SkillSaveOutcome = "created" | "updated" | "shadowed";

/**
 * What deleting a skill's org copy did: `removed` when the folder is gone, `reverted` when the builtin copy it
 * shadowed shows again. `unchanged` (builtin-only) and `missing` (unknown) write nothing.
 */
export type SkillRemoveOutcome =
  | "removed"
  | "reverted"
  | "unchanged"
  | "missing";

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

/** The skills a conversation started with. A fork keeps its parent's. */
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

/** Delete skills' `.skills/<name>/` folders from a sandbox, ignoring ones already gone. */
const uninstall = (
  env: ExecutionEnv,
  names: readonly string[],
  context: ChordContext
) =>
  Effect.forEach(
    names,
    (name) => {
      const target = path.posix.join(SANDBOX_SKILLS_DIR, name);
      return envCall(`Could not remove ${target}`, () =>
        env.remove(target, { recursive: true, force: true }, context)
      );
    },
    { discard: true }
  );

/** Whether a sandbox has the skill's `.skills/<name>/` folder. */
const isInstalled = (env: ExecutionEnv, name: string, context: ChordContext) =>
  Effect.tryPromise({
    try: () => env.exists(path.posix.join(SANDBOX_SKILLS_DIR, name), context),
    catch: (cause) =>
      new SkillInstallError({
        message: `Could not check ${name}: ${String(cause)}`,
      }),
  }).pipe(Effect.map((result) => result.ok && result.value));

export class Skills extends Context.Service<
  Skills,
  {
    /** The source's skills now: every folder with a valid SKILL.md, and why the others were skipped. */
    readonly catalog: Effect.Effect<SkillCatalog, SkillSourceError>;
    /**
     * Create or replace the org folder `name` with `files` (the whole folder, text only), after it passes
     * `checkSkillFiles` — a folder that fails is never written. `outcome` says what the write did.
     */
    readonly save: (
      name: string,
      files: Readonly<Record<string, string>>
    ) => Effect.Effect<
      { readonly skill: Skill; readonly outcome: SkillSaveOutcome },
      InvalidSkill | SkillSourceError
    >;
    /** Delete `name`'s org copy; the outcome says what changed, and builtin folders are never touched. */
    readonly remove: (
      name: string
    ) => Effect.Effect<SkillRemoveOutcome, SkillSourceError>;
    /**
     * A folder's merged contents — the org copy's files, with any unshadowed builtin ones — or `undefined` when
     * no folder lists `id`. For the console's editor.
     */
    readonly folder: (id: string) => Effect.Effect<
      | {
          readonly origin: SkillOrigin;
          readonly files: Record<string, Uint8Array>;
        }
      | undefined,
      SkillSourceError
    >;
    /**
     * What the `skill` tool returns: a bundled file, or SKILL.md with a header listing the other files. `sandboxDir`
     * is the skill's folder in the sandbox, when there is one.
     */
    readonly read: (
      skill: Skill,
      file?: string,
      sandboxDir?: string
    ) => Effect.Effect<string, SkillSourceError | SkillFileNotFound>;
    /** The SKILL.md body after its frontmatter, for the console's skills page. */
    readonly body: (skill: Skill) => Effect.Effect<string, SkillSourceError>;
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
    /**
     * Replace one skill's `.skills/<name>/` folder with the source's current files. Every file is read first and
     * written to a staging folder that then takes the old one's place, so on any failure the old copy stays.
     */
    readonly replace: (
      env: ExecutionEnv,
      skill: Skill,
      context: ChordContext
    ) => Effect.Effect<void, SkillSourceError | SkillInstallError>;
    /** Whether the sandbox has the skill's `.skills/<name>/` folder. */
    readonly isInstalled: (
      env: ExecutionEnv,
      name: string,
      context: ChordContext
    ) => Effect.Effect<boolean, SkillInstallError>;
    /** Delete the skills' `.skills/<name>/` folders from the sandbox, ignoring ones already gone. */
    readonly uninstall: (
      env: ExecutionEnv,
      names: readonly string[],
      context: ChordContext
    ) => Effect.Effect<void, SkillInstallError>;
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

      const save = Effect.fnUntraced(function* (
        name: string,
        files: Readonly<Record<string, string>>
      ) {
        // Validate fully before anything is written: a folder that fails leaves the source untouched.
        const skill = yield* checkSkillFiles(name, files);
        const listed = (yield* source.list).find(
          (folder) => folder.id === name
        );
        let outcome: SkillSaveOutcome = "updated";
        if (listed === undefined) {
          outcome = "created";
        } else if (listed.origin === "builtin") {
          outcome = "shadowed";
        }
        yield* source.put(name, files);
        return { skill, outcome };
      });

      const remove = Effect.fnUntraced(function* (name: string) {
        const listed = (yield* source.list).find(
          (folder) => folder.id === name
        );
        if (listed === undefined) {
          return "missing" as const;
        }
        if (listed.origin === "builtin") {
          return "unchanged" as const;
        }
        yield* source.remove(name);
        return listed.origin === "org"
          ? ("removed" as const)
          : ("reverted" as const);
      });

      const folder = Effect.fnUntraced(function* (id: string) {
        const listed = (yield* source.list).find((each) => each.id === id);
        if (listed === undefined) {
          return;
        }
        const files = yield* Effect.forEach(
          listed.files,
          (file) =>
            source
              .read(id, file)
              .pipe(Effect.map((bytes) => [file, bytes] as const)),
          { concurrency: 8 }
        );
        return { origin: listed.origin, files: Object.fromEntries(files) };
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

      const replace = Effect.fnUntraced(function* (
        env: ExecutionEnv,
        skill: Skill,
        context: ChordContext
      ) {
        // Read before touching the sandbox: a file the source lost leaves the old copy in place.
        const files = yield* Effect.all(
          skill.files.map((file) =>
            source
              .read(skill.id, file)
              .pipe(Effect.map((contents) => ({ file, contents })))
          )
        );
        const target = path.posix.join(SANDBOX_SKILLS_DIR, skill.name);
        const staging = path.posix.join(
          SANDBOX_SKILLS_DIR,
          `.${skill.name}.staging`
        );
        const removeStaging = envCall(`Could not remove ${staging}`, () =>
          env.remove(staging, { recursive: true, force: true }, context)
        );
        yield* removeStaging;
        yield* Effect.gen(function* () {
          for (const { file, contents } of files) {
            const written = path.posix.join(staging, file);
            yield* envCall(
              `Could not create ${path.posix.dirname(written)}`,
              () =>
                env.createDir(
                  path.posix.dirname(written),
                  { recursive: true },
                  context
                )
            );
            yield* envCall(`Could not write ${written}`, () =>
              env.writeFile(written, contents, context)
            );
          }
          yield* envCall("Could not make skill scripts executable", () =>
            env.exec(
              `find '${staging}' -path '*/scripts/*' -type f -exec chmod +x {} + 2>/dev/null; true`,
              {},
              context
            )
          );
          yield* envCall(`Could not remove ${target}`, () =>
            env.remove(target, { recursive: true, force: true }, context)
          );
          yield* envCall(`Could not move ${staging} to ${target}`, () =>
            env.renameFile(staging, target, context)
          );
        }).pipe(Effect.onError(() => Effect.ignore(removeStaging)));
      });

      const body = (skill: Skill) =>
        readText(skill.id, SKILL_FILE).pipe(
          Effect.map((text) => parseSkillFile(text).body)
        );

      return Skills.of({
        catalog,
        save,
        remove,
        folder,
        read,
        body,
        expand,
        install,
        replace,
        isInstalled,
        uninstall,
      });
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

/** The skills a conversation recorded; every conversation records them when it is created, so none without. */
const conversationSkills = async (
  reader: DocumentReader,
  conversationId: ConversationId,
  context: ChordContext
): Promise<readonly Skill[]> => {
  const doc = await reader.snapshot(SkillsDoc, conversationId, context);
  return doc?.skills ?? [];
};

/** The `skill` tool and the section listing the skills, both reading the conversation's `SkillsDoc`. */
export const skillsExtension = (skills: Skills["Service"]): Extension =>
  defineExtension({
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
              sandboxDir?.ok ? sandboxDir.value : undefined
            )
          );
          return { content: [{ type: "text" as const, text }] };
        },
      }),
    ],
  });

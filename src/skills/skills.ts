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
import { Cause, Context, Effect, Exit, Layer, Schema, Semaphore } from "effect";

import { withApproval } from "../approvals.ts";
import { SkillNotFound } from "../errors.ts";
import {
  checkSkillFiles,
  decodeSkill,
  InvalidSkill,
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
     * The listed folder's files — the org copy wholesale when the skill is overridden — or `undefined` when no
     * folder lists `id`. For the console's editor.
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
      // The outcome of a save or remove is computed from a list: serialize the two, or a racing writer could
      // turn the other's "created" into an "updated" — or lose a folder between the read and the write.
      const writing = yield* Semaphore.make(1);
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
          } else if (decoded.success.name !== folder.id) {
            // GET, folder and remove resolve by folder id: a mismatched name would list a skill they cannot reach.
            problems.push(
              `${folder.id}: skill name "${decoded.success.name}" doesn't match its folder`
            );
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
        const outcome = yield* writing.withPermit(
          Effect.gen(function* () {
            const listed = (yield* source.list).find(
              (folder) => folder.id === name
            );
            yield* source.put(name, files);
            if (listed === undefined) {
              return "created" as const;
            }
            return listed.origin === "builtin"
              ? ("shadowed" as const)
              : ("updated" as const);
          })
        );
        return { skill, outcome };
      });

      const remove = Effect.fnUntraced(function* (name: string) {
        return yield* writing.withPermit(
          Effect.gen(function* () {
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
          })
        );
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

  /** Skills from folders under `root` on the host; `orgRoot` keeps the writable overlay outside it. */
  static readonly directory = (root: string, orgRoot?: string) =>
    Skills.layer.pipe(
      Layer.provide(SkillSource.directory(root, orgRoot)),
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

/**
 * What `skill_save`/`skill_delete` report so the calling conversation's settings can follow: `onSaved` enables a
 * created skill or refreshes an enabled edited one, `onDeleted` disables a removed one or refreshes a reverted
 * one. Each resolves whether the conversation's state was applied; the tool's text tells the model.
 */
export interface SkillEditHooks {
  readonly onSaved: (
    id: ConversationId,
    name: string,
    outcome: SkillSaveOutcome
  ) => Promise<boolean>;
  readonly onDeleted: (
    id: ConversationId,
    name: string,
    outcome: SkillRemoveOutcome
  ) => Promise<boolean>;
}

// Models sometimes send `files` as a JSON string; a copy is repaired, the call's arguments stay unchanged.
const prepareSkillSaveArguments = (input: unknown) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input as {
      name: string;
      files: Record<string, string>;
      reason: string;
    };
  }
  const args = { ...input } as Record<string, unknown>;
  if (typeof args.files === "string") {
    try {
      const parsed: unknown = JSON.parse(args.files);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        args.files = parsed;
      }
    } catch {
      // Left as the string: the schema reports it.
    }
  }
  return args as {
    name: string;
    files: Record<string, string>;
    reason: string;
  };
};

const savedText = (
  name: string,
  outcome: SkillSaveOutcome,
  applied: boolean
): string => {
  if (outcome === "created") {
    // `applied` only fails when the hook threw, after the write landed.
    return applied
      ? `Saved new skill "${name}"; it's on in this conversation and in every new one.`
      : `Saved new skill "${name}". New conversations get it; turning it on here failed.`;
  }
  if (applied) {
    return `Updated skill "${name}"; this conversation's copy is refreshed.${
      outcome === "shadowed"
        ? " It overrides the built-in; skill_delete restores the built-in."
        : ""
    }`;
  }
  return `Updated skill "${name}". It's off here; new conversations get it.`;
};

const deletedText = (
  name: string,
  outcome: SkillRemoveOutcome,
  applied: boolean
): string => {
  switch (outcome) {
    case "removed": {
      return applied
        ? `Deleted skill "${name}"; it's off in this conversation.`
        : `Deleted skill "${name}".`;
    }
    case "reverted": {
      return applied
        ? `Reverted "${name}" to the built-in version; this conversation's copy is refreshed.`
        : `Reverted "${name}" to the built-in version.`;
    }
    case "unchanged": {
      return `"${name}" is built in — nothing to delete; save an override with skill_save.`;
    }
    case "missing": {
      return `No skill named "${name}" — nothing to delete.`;
    }
    default: {
      throw new TypeError(`Unknown outcome: ${outcome satisfies never}`);
    }
  }
};

/**
 * The write already landed when a hook runs: a hook that throws only means the calling conversation's copy
 * fell behind — say so rather than reporting a failed call.
 */
const appliedFrom = async (run: () => Promise<boolean>) => {
  try {
    return { applied: await run(), note: "" };
  } catch (error) {
    return {
      applied: false,
      note: ` This conversation's copy could not be updated: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
};

/**
 * The `skill` read tool plus the `skill_save`/`skill_delete` write tools, and the section listing the skills;
 * reads go through the conversation's `SkillsDoc`, writes through the source and back via `hooks`.
 */
export const skillsExtension = (
  skills: Skills["Service"],
  hooks: SkillEditHooks
): Extension =>
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
      withApproval(
        defineTool({
          name: "skill_save",
          description:
            "Create a skill, or replace one wholesale: `files` is every file the skill's folder will hold (relative paths, text only) and must include SKILL.md with frontmatter `name` (equal to `name`, lowercase letters, digits and single hyphens) and `description` — a task matching the description is when the skill applies. Saving over a built-in skill's name shadows it; skill_delete restores the built-in. A new skill turns on in this conversation and in every new one; editing one that is on refreshes its sandbox copy.",
          parameters: Type.Object({
            name: Type.String({ description: "The skill's name" }),
            files: Type.Record(Type.String(), Type.String(), {
              description:
                "Every file the folder will hold, relative paths to text contents; must include SKILL.md",
            }),
            reason: Type.String({
              description: "Why, shown to the person approving",
            }),
          }),
          prepareArguments: prepareSkillSaveArguments,
          // Writes the source: never rerun blindly after a crash.
          replay: "unsafe",
          execute: async (args, api) => {
            const saved = await Effect.runPromiseExit(
              skills.save(args.name, args.files)
            );
            if (Exit.isFailure(saved)) {
              const failure = Cause.squash(saved.cause);
              // An InvalidSkill is the model's to fix; anything else is a defect.
              throw failure instanceof InvalidSkill
                ? new Error(failure.message)
                : failure;
            }
            const { applied, note } = await appliedFrom(() =>
              hooks.onSaved(api.conversationId, args.name, saved.value.outcome)
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    savedText(args.name, saved.value.outcome, applied) + note,
                },
              ],
            };
          },
        })
      ),
      withApproval(
        defineTool({
          name: "skill_delete",
          description:
            "Delete a skill's editable copy: one that exists only there is gone, one shadowing a built-in reverts to the built-in version, and a deleted skill turns off in this conversation. A built-in skill cannot be deleted — shadow it with skill_save first.",
          parameters: Type.Object({
            name: Type.String({ description: "The skill's name" }),
            reason: Type.String({
              description: "Why, shown to the person approving",
            }),
          }),
          replay: "unsafe",
          execute: async (args, api) => {
            const outcome = await Effect.runPromise(skills.remove(args.name));
            const { applied, note } =
              outcome === "removed" || outcome === "reverted"
                ? await appliedFrom(() =>
                    hooks.onDeleted(api.conversationId, args.name, outcome)
                  )
                : { applied: false, note: "" };
            return {
              content: [
                {
                  type: "text" as const,
                  text: deletedText(args.name, outcome, applied) + note,
                },
              ],
            };
          },
        })
      ),
    ],
  });

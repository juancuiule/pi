// Where skills are stored. A source only lists folders and reads their files; it knows nothing about SKILL.md, its
// frontmatter or sandboxes (`Skills` in ./skills.ts does). The repository's `skills/` folder is one source; an S3
// prefix or a database table can be another by implementing this service.
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

/** One folder: its id in the source and every file in it, relative to it with `/` separators. */
export interface SkillFolder {
  readonly id: string;
  readonly files: readonly string[];
}

export class SkillSourceError extends Schema.TaggedError<SkillSourceError>()(
  "SkillSourceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) }
) {}

const fail = (message: string) => (cause: unknown) =>
  new SkillSourceError({ message, cause });

export class SkillSource extends Context.Service<
  SkillSource,
  {
    /** Every folder, sorted by id. Read on every call, so a dynamic source shows its latest contents. */
    readonly list: Effect.Effect<readonly SkillFolder[], SkillSourceError>;
    readonly read: (
      id: string,
      file: string
    ) => Effect.Effect<Uint8Array, SkillSourceError>;
  }
>()("effect-pi/skills/SkillSource") {
  /** Folders under `root` on the host; a missing `root` has none. Entries starting with `.` are skipped. */
  static readonly directory = (root: string) =>
    Layer.effect(
      SkillSource,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const listFiles = (
          dir: string,
          prefix: string
        ): Effect.Effect<string[], SkillSourceError> =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(path.join(dir, prefix));
            const nested = yield* Effect.forEach(
              entries.filter((entry) => !entry.startsWith(".")),
              (entry) => {
                const relative = prefix === "" ? entry : `${prefix}/${entry}`;
                return fs
                  .stat(path.join(dir, relative))
                  .pipe(
                    Effect.flatMap((info) =>
                      info.type === "Directory"
                        ? listFiles(dir, relative)
                        : Effect.succeed([relative])
                    )
                  );
              }
            );
            return nested.flat();
          }).pipe(Effect.mapError(fail(`Could not list ${dir}`)));

        const list = Effect.gen(function* () {
          if (!(yield* fs.exists(root))) {
            return [];
          }
          const entries = (yield* fs.readDirectory(root)).toSorted();
          const folders = yield* Effect.forEach(
            entries,
            (id) =>
              Effect.gen(function* () {
                const dir = path.join(root, id);
                const info = yield* fs.stat(dir);
                return id.startsWith(".") || info.type !== "Directory"
                  ? []
                  : [{ id, files: yield* listFiles(dir, "") }];
              }),
            { concurrency: 8 }
          );
          return folders.flat();
        }).pipe(Effect.mapError(fail(`Could not list skills in ${root}`)));

        return SkillSource.of({
          list,
          read: (id, file) =>
            fs
              .readFile(path.join(root, id, file))
              .pipe(Effect.mapError(fail(`Could not read ${id}/${file}`))),
        });
      })
    );

  /** Folders from `{ "<id>/<file>": contents }`, read on every call, for tests and skills built in code. */
  static readonly memory = (files: Readonly<Record<string, string>>) => {
    const encoder = new TextEncoder();
    return Layer.succeed(
      SkillSource,
      SkillSource.of({
        list: Effect.sync(() => {
          const byId = new Map<string, string[]>();
          for (const key of Object.keys(files).toSorted()) {
            const [id = "", ...rest] = key.split("/");
            byId.set(id, [...(byId.get(id) ?? []), rest.join("/")]);
          }
          return [...byId].map(([id, folderFiles]) => ({
            id,
            files: folderFiles,
          }));
        }),
        read: (id, file) =>
          Effect.suspend(() => {
            const contents = files[`${id}/${file}`];
            return contents === undefined
              ? Effect.fail(
                  new SkillSourceError({ message: `No file ${id}/${file}` })
                )
              : Effect.succeed(encoder.encode(contents));
          }),
      })
    );
  };
}

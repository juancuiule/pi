// Where skills are stored. A source lists folders and reads and writes their files; it knows nothing about
// SKILL.md, its frontmatter or sandboxes (`Skills` in ./skills.ts does). Folders live in two namespaces that
// share ids: `builtin` (the repository's skills, read-only here — `convergeBuiltin` below is its only writer)
// and `org`, the writable overlay. An org folder shadows a builtin one of the same id, in `list` as a whole
// folder and in `read` per file.
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { PlatformError } from "effect";

import type { ObjectStore } from "../storage/object-store.ts";

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

/** The writable namespace; the `org` name can never be a builtin folder. */
const ORG = "org";

/** A folder's file path: `/`-joined segments of plain names — no `.`-names (list skips them), `..`, empties or `\`. */
export const isSkillFile = (file: string): boolean =>
  file
    .split("/")
    .every(
      (segment) =>
        segment !== "" && !segment.startsWith(".") && !segment.includes("\\")
    );

/** A folder id is a single file segment; `a/b` or `..` would escape the source's org root. */
const isSkillId = (id: string): boolean => isSkillFile(id) && !id.includes("/");

const invalidId = (id: string) =>
  Effect.fail(
    new SkillSourceError({ message: `Invalid skill folder id: ${id}` })
  );

const invalidFile = (file: string) =>
  Effect.fail(
    new SkillSourceError({ message: `Invalid skill file path: ${file}` })
  );

/** The first thing wrong with a `put`, or `undefined`: the id and every file path must be valid. */
const invalidPut = (
  id: string,
  files: Readonly<Record<string, unknown>>
): SkillSourceError | undefined => {
  if (!isSkillId(id)) {
    return new SkillSourceError({ message: `Invalid skill folder id: ${id}` });
  }
  for (const file of Object.keys(files)) {
    if (!isSkillFile(file)) {
      return new SkillSourceError({
        message: `Invalid skill file path: ${file}`,
      });
    }
  }
};

const encoder = new TextEncoder();

const bytesOf = (contents: Uint8Array | string): Uint8Array =>
  typeof contents === "string" ? encoder.encode(contents) : contents;

/**
 * `<id>/<file>` tails grouped into folders, sorted by id. `.`-named folders and file segments are skipped, like
 * the directory source's dotfile rule; a tail with no file part is not a folder.
 */
const groupKeys = (tails: readonly string[]): Map<string, string[]> => {
  const byId = new Map<string, string[]>();
  for (const tail of tails) {
    const [id = "", ...rest] = tail.split("/");
    if (id === "" || id.startsWith(".") || rest.length === 0) {
      continue;
    }
    if (rest.some((segment) => segment.startsWith("."))) {
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), rest.join("/")]);
  }
  return new Map(
    [...byId].map(([id, files]) => [id, files.toSorted()] as const)
  );
};

/** Builtin folders overlaid by org ones: an org folder replaces the builtin folder of its id. */
const merged = (
  builtin: Map<string, string[]>,
  org: Map<string, string[]>
): readonly SkillFolder[] => {
  const byId = new Map(builtin);
  for (const [id, files] of org) {
    byId.set(id, files);
  }
  return [...byId]
    .map(([id, files]) => ({ id, files }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
};

/** A folder's file paths under `dir`, `.`-named entries skipped, for both the directory source and convergence. */
const listFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
  prefix: string
): Effect.Effect<string[], PlatformError.PlatformError> =>
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
                ? listFiles(fs, path, dir, relative)
                : Effect.succeed([relative])
            )
          );
      }
    );
    return nested.flat();
  });

/** `org/<id>/` (no file) is the folder's key prefix; `org/<id>/<file>` one of its files. */
const orgKey = (id: string, file?: string) =>
  file === undefined ? `org/${id}/` : `org/${id}/${file}`;

export class SkillSource extends Context.Service<
  SkillSource,
  {
    /** Every folder, sorted by id, org shadowing builtin. Read on every call, so a dynamic source shows its latest contents. */
    readonly list: Effect.Effect<readonly SkillFolder[], SkillSourceError>;
    /** A file's bytes: the org copy first, then builtin, so a shadowed folder can still read an unshadowed file. */
    readonly read: (
      id: string,
      file: string
    ) => Effect.Effect<Uint8Array, SkillSourceError>;
    /**
     * Replace the org copy of folder `id` with `files` (relative paths to text or bytes); files the previous copy
     * had and `files` does not are removed. `builtin/` is never written.
     */
    readonly put: (
      id: string,
      files: Readonly<Record<string, Uint8Array | string>>
    ) => Effect.Effect<void, SkillSourceError>;
    /**
     * Delete the org copy of folder `id`; a builtin-only id has no org copy, so removing it is a no-op and the
     * folder keeps listing — builtin folders go away through the repository (and `convergeBuiltin`), never here.
     */
    readonly remove: (id: string) => Effect.Effect<void, SkillSourceError>;
  }
>()("effect-pi/skills/SkillSource") {
  /**
   * Folders under `root` on the host; a missing `root` has none. Top-level folders are builtin and `root/org/*`
   * the org overlay, which `put` writes and `remove` deletes. Entries starting with `.` are skipped.
   */
  static readonly directory = (root: string) =>
    Layer.effect(
      SkillSource,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const orgRoot = path.join(root, ORG);

        // The folders directly under a directory.
        const foldersIn = (
          dir: string
        ): Effect.Effect<SkillFolder[], SkillSourceError> =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(dir))) {
              return [];
            }
            const entries = (yield* fs.readDirectory(dir)).toSorted();
            const folders = yield* Effect.forEach(
              entries,
              (id) =>
                Effect.gen(function* () {
                  const target = path.join(dir, id);
                  const info = yield* fs.stat(target);
                  return id.startsWith(".") || info.type !== "Directory"
                    ? []
                    : [
                        {
                          id,
                          files: (yield* listFiles(
                            fs,
                            path,
                            target,
                            ""
                          )).toSorted(),
                        },
                      ];
                }),
              { concurrency: 8 }
            );
            return folders.flat();
          }).pipe(Effect.mapError(fail(`Could not list skills in ${dir}`)));

        const list = Effect.gen(function* () {
          const byId = new Map<string, SkillFolder>();
          for (const folder of yield* foldersIn(root)) {
            if (folder.id !== ORG) {
              byId.set(folder.id, folder);
            }
          }
          for (const folder of yield* foldersIn(orgRoot)) {
            byId.set(folder.id, folder);
          }
          return [...byId.values()].toSorted((a, b) =>
            a.id.localeCompare(b.id)
          );
        });

        return SkillSource.of({
          list,
          read: (id, file) => {
            if (!isSkillId(id)) {
              return invalidId(id);
            }
            if (!isSkillFile(file)) {
              return invalidFile(file);
            }
            return Effect.gen(function* () {
              const orgFile = path.join(orgRoot, id, file);
              const target = (yield* fs.exists(orgFile))
                ? orgFile
                : path.join(root, id, file);
              return yield* fs.readFile(target);
            }).pipe(Effect.mapError(fail(`Could not read ${id}/${file}`)));
          },
          put: (id, files) => {
            const invalid = invalidPut(id, files);
            if (invalid !== undefined) {
              return Effect.fail(invalid);
            }
            const dir = path.join(orgRoot, id);
            return Effect.gen(function* () {
              yield* fs.remove(dir, { recursive: true, force: true });
              yield* Effect.forEach(
                Object.entries(files),
                ([file, contents]) =>
                  Effect.gen(function* () {
                    const target = path.join(dir, file);
                    yield* fs.makeDirectory(path.dirname(target), {
                      recursive: true,
                    });
                    yield* fs.writeFile(target, bytesOf(contents));
                  }),
                { concurrency: 8, discard: true }
              );
            }).pipe(Effect.mapError(fail(`Could not write ${ORG}/${id}`)));
          },
          remove: (id) =>
            isSkillId(id)
              ? fs
                  .remove(path.join(orgRoot, id), {
                    recursive: true,
                    force: true,
                  })
                  .pipe(Effect.mapError(fail(`Could not remove ${ORG}/${id}`)))
              : invalidId(id),
        });
      })
    );

  /**
   * Folders from `{ "<id>/<file>": contents }`, read on every call, for tests and skills built in code. Keys may
   * carry the namespaces — `builtin/<id>/<file>` or `org/<id>/<file>`; bare `<id>/<file>` keys are builtin.
   * `put`/`remove` write and delete the record's `org/<id>/` keys.
   */
  static readonly memory = (files: Record<string, string | Uint8Array>) =>
    Layer.succeed(
      SkillSource,
      SkillSource.of({
        list: Effect.sync(() => {
          const keys = Object.keys(files);
          return merged(
            groupKeys(
              keys.flatMap((key) =>
                key.startsWith(`${ORG}/`)
                  ? []
                  : [key.startsWith("builtin/") ? key.slice(8) : key]
              )
            ),
            groupKeys(
              keys.flatMap((key) =>
                key.startsWith(`${ORG}/`) ? [key.slice(4)] : []
              )
            )
          );
        }),
        read: (id, file) => {
          if (!isSkillId(id)) {
            return invalidId(id);
          }
          if (!isSkillFile(file)) {
            return invalidFile(file);
          }
          return Effect.suspend(() => {
            const contents =
              files[`${ORG}/${id}/${file}`] ??
              files[`builtin/${id}/${file}`] ??
              files[`${id}/${file}`];
            return contents === undefined
              ? Effect.fail(
                  new SkillSourceError({ message: `No file ${id}/${file}` })
                )
              : Effect.succeed(
                  contents instanceof Uint8Array
                    ? new Uint8Array(contents)
                    : encoder.encode(contents)
                );
          });
        },
        put: (id, added) => {
          const invalid = invalidPut(id, added);
          if (invalid !== undefined) {
            return Effect.fail(invalid);
          }
          return Effect.sync(() => {
            for (const key of Object.keys(files)) {
              if (key.startsWith(`${ORG}/${id}/`)) {
                Reflect.deleteProperty(files, key);
              }
            }
            for (const [file, contents] of Object.entries(added)) {
              files[`${ORG}/${id}/${file}`] = contents;
            }
          });
        },
        remove: (id) =>
          isSkillId(id)
            ? Effect.sync(() => {
                for (const key of Object.keys(files)) {
                  if (key.startsWith(`${ORG}/${id}/`)) {
                    Reflect.deleteProperty(files, key);
                  }
                }
              })
            : invalidId(id),
      })
    );

  /**
   * Folders in an ObjectStore bucket: `builtin/<id>/<file>` and `org/<id>/<file>` keys. `put`/`remove` only ever
   * touch `org/`; `builtin/` belongs to `convergeBuiltin`.
   */
  static readonly s3 = (store: ObjectStore, bucket: string) =>
    Layer.succeed(
      SkillSource,
      SkillSource.of({
        list: Effect.tryPromise({
          try: async () => {
            const [builtin, org] = await Promise.all([
              store.list(bucket, "builtin/"),
              store.list(bucket, `${ORG}/`),
            ]);
            return merged(
              groupKeys(builtin.map((object) => object.key.slice(8))),
              groupKeys(org.map((object) => object.key.slice(4)))
            );
          },
          catch: fail(`Could not list skills in ${bucket}`),
        }),
        read: (id, file) => {
          if (!isSkillId(id)) {
            return invalidId(id);
          }
          if (!isSkillFile(file)) {
            return invalidFile(file);
          }
          return Effect.tryPromise({
            try: async () =>
              (await store.get(bucket, orgKey(id, file))) ??
              (await store.get(bucket, `builtin/${id}/${file}`)),
            catch: fail(`Could not read ${id}/${file}`),
          }).pipe(
            Effect.flatMap((bytes) =>
              bytes === undefined
                ? Effect.fail(
                    new SkillSourceError({ message: `No file ${id}/${file}` })
                  )
                : Effect.succeed(bytes)
            )
          );
        },
        put: (id, files) => {
          const invalid = invalidPut(id, files);
          if (invalid !== undefined) {
            return Effect.fail(invalid);
          }
          return Effect.tryPromise({
            try: async () => {
              await store.removePrefix(bucket, orgKey(id));
              await Promise.all(
                Object.entries(files).map(([file, contents]) =>
                  store.put(bucket, orgKey(id, file), bytesOf(contents))
                )
              );
            },
            catch: fail(`Could not write ${ORG}/${id}`),
          });
        },
        remove: (id) =>
          isSkillId(id)
            ? Effect.tryPromise({
                try: () => store.removePrefix(bucket, orgKey(id)),
                catch: fail(`Could not remove ${ORG}/${id}`),
              })
            : invalidId(id),
      })
    );
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined &&
  a.length === b.length &&
  a.every((byte, i) => byte === b[i]);

/**
 * Converge the bucket's `builtin/` keys to the skill folders under `dir`: upload new and changed files, remove
 * the ones `dir` no longer has. `SkillSource.put` only writes `org/`; this is the one writer of `builtin/`, run
 * at startup under STORAGE=s3 so the repository stays the source of the built-in skills.
 */
export const convergeBuiltin = (options: {
  readonly store: ObjectStore;
  readonly bucket: string;
  readonly dir: string;
}): Effect.Effect<void, SkillSourceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { store, bucket, dir } = options;

    // No skills dir is a configuration problem, not an empty one: leave builtin/ as it is rather than wipe it.
    if (!(yield* fs.exists(dir))) {
      return;
    }
    const local = new Map<string, Uint8Array>();
    for (const id of yield* fs.readDirectory(dir)) {
      if (id.startsWith(".") || id === ORG) {
        continue;
      }
      const folder = path.join(dir, id);
      if ((yield* fs.stat(folder)).type !== "Directory") {
        continue;
      }
      for (const file of yield* listFiles(fs, path, folder, "")) {
        local.set(
          `builtin/${id}/${file}`,
          yield* fs.readFile(path.join(folder, file))
        );
      }
    }

    yield* Effect.tryPromise({
      try: async () => {
        const remote = await store.list(bucket, "builtin/");
        const sizes = new Map(
          remote.map((object) => [object.key, object.size])
        );
        await Promise.all(
          [...local].map(async ([key, bytes]) => {
            const current =
              sizes.get(key) === bytes.length
                ? await store.get(bucket, key)
                : undefined;
            if (!sameBytes(current, bytes)) {
              await store.put(bucket, key, bytes);
            }
          })
        );
        await Promise.all(
          remote.map(async ({ key }) => {
            if (!local.has(key)) {
              await store.remove(bucket, key);
            }
          })
        );
      },
      catch: fail(`Could not converge builtin/ in ${bucket}`),
    });
  }).pipe(
    Effect.mapError(fail(`Could not converge builtin/ in ${options.bucket}`))
  );

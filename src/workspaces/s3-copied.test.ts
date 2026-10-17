// s3-copied workspace storage over the local-directory Sandboxes and a memory ObjectStore: the tar really runs
// (`exec` on the host), the snapshot really uploads, and the cache is a directory that outlives its Sandbox
// until evicted. The real gateway runs the same flow in s3-copied.s3.test.ts.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { BUCKETS, memory } from "../storage/object-store.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { directoryCache, localSandboxes } from "../testing/sandboxes.ts";
import * as S3Copied from "./s3-copied.ts";
import { Workspaces, WorkspaceStorage } from "./workspaces.ts";

const BUCKET = BUCKETS.workspaces;

const setup = (store: ObjectStore = memory()) => {
  const local = localSandboxes();
  const root = mkdtempSync(path.join(tmpdir(), "effect-pi-cache-"));
  const layer = Workspaces.layer.pipe(
    Layer.provideMerge(
      S3Copied.layer({
        store,
        cache: directoryCache(root, local.live),
      })
    ),
    Layer.provide(local.sandboxes)
  );
  return { root, store, layer };
};

/** The cache directory a Workspace's storage ref maps to. */
const cacheDir = (root: string, id: string) => path.join(root, id);

const populate = (root: string, id: string) => {
  const dir = cacheDir(root, id);
  writeFileSync(path.join(dir, "note.txt"), "kept");
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "sub", "file.ts"), "export const x = 1;\n");
};

/** The member names of a saved snapshot's tar. */
const tarList = (packed: Uint8Array) => {
  const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-tar-"));
  const file = path.join(dir, "files.tar");
  try {
    writeFileSync(file, zstdDecompressSync(packed));
    return execFileSync("tar", ["tf", file], { encoding: "utf-8" })
      .split("\n")
      .filter((name) => name !== "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("s3-copied workspace storage", () => {
  it("saves /workspace minus .attachments and .skills, and restores it into a fresh Sandbox", async () => {
    const { root, store, layer } = setup();

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const files = yield* Effect.scoped(
          Effect.gen(function* () {
            const { storage } = yield* workspaces.sandbox({ level: "shell" });
            populate(root, storage.id);
            const dir = cacheDir(root, storage.id);
            mkdirSync(path.join(dir, ".attachments", "a1"), {
              recursive: true,
            });
            writeFileSync(
              path.join(dir, ".attachments", "a1", "file.csv"),
              "x,y\n"
            );
            mkdirSync(path.join(dir, ".skills", "s1"), { recursive: true });
            writeFileSync(path.join(dir, ".skills", "s1", "SKILL.md"), "---\n");
            return storage;
          })
        );
        // The Seat ended: the snapshot is in the store and the cache is evicted.
        const packed = yield* Effect.promise(() =>
          store.get(BUCKET, `${files.id}/files.tar.zst`)
        );
        const seen = yield* Effect.scoped(
          Effect.gen(function* () {
            const { storage } = yield* workspaces.sandbox({
              level: "shell",
              storage: files,
            });
            const dir = cacheDir(root, storage.id);
            return [
              existsSync(path.join(dir, "note.txt"))
                ? readFileSync(path.join(dir, "note.txt"), "utf-8")
                : undefined,
              existsSync(path.join(dir, ".attachments", "a1", "file.csv")),
              existsSync(path.join(dir, ".skills", "s1", "SKILL.md")),
            ] as const;
          })
        );
        return {
          members: tarList(packed as Uint8Array),
          evicted: !existsSync(cacheDir(root, files.id)),
          seen,
        };
      }).pipe(Effect.provide(layer))
    );

    expect([
      outcome.members.includes("./note.txt"),
      outcome.members.includes("./sub/file.ts"),
      outcome.members.some((name) => name.includes(".attachments")),
      outcome.members.some((name) => name.includes(".skills")),
    ]).toStrictEqual([true, true, false, false]);
    expect(outcome.seen).toStrictEqual(["kept", false, false]);
    // Both Seats' closes saved and evicted.
    expect(outcome.evicted).toBeTruthy();
  });

  it("starts an empty Workspace when the store has no snapshot", async () => {
    const { root, store, layer } = setup();

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        return yield* Effect.scoped(
          workspaces
            .sandbox({ level: "shell" })
            .pipe(
              Effect.map(({ storage }) =>
                readdirSync(cacheDir(root, storage.id))
              )
            )
        );
      }).pipe(Effect.provide(layer))
    );

    expect(entries).toStrictEqual([]);
    await expect(store.list(BUCKET, "")).resolves.not.toStrictEqual([]);
  });

  it("fails the open on a corrupt snapshot without saving over it", async () => {
    const { root, store, layer } = setup();
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);

    const opened = await Effect.runPromise(
      Effect.gen(function* () {
        const storageService = yield* WorkspaceStorage;
        const workspaces = yield* Workspaces;
        const files = yield* storageService.create;
        yield* Effect.promise(() =>
          store.put(BUCKET, `${files.id}/files.tar.zst`, garbage)
        );
        const exit = yield* Effect.exit(
          Effect.scoped(workspaces.sandbox({ level: "shell", storage: files }))
        );
        return { exit, files };
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(opened.exit)).toBeTruthy();
    // The bad snapshot is still there, not overwritten by a save of the half-restored mount,
    // and its dirty cache is evicted so the next open retries the download.
    await expect(
      store.get(BUCKET, `${opened.files.id}/files.tar.zst`)
    ).resolves.toStrictEqual(garbage);
    expect(existsSync(cacheDir(root, opened.files.id))).toBeFalsy();
  });

  it("skips the download when the mounted cache is already populated", async () => {
    const { root, store, layer } = setup();

    const note = await Effect.runPromise(
      Effect.gen(function* () {
        const storageService = yield* WorkspaceStorage;
        const workspaces = yield* Workspaces;
        const files = yield* storageService.create;
        populate(root, files.id);
        // A snapshot that would fail a real restore: populated mounts never reach it.
        yield* Effect.promise(() =>
          store.put(BUCKET, `${files.id}/files.tar.zst`, new Uint8Array([9]))
        );
        return yield* Effect.scoped(
          workspaces
            .sandbox({ level: "shell", storage: files })
            .pipe(
              Effect.map(({ storage }) =>
                readFileSync(
                  path.join(cacheDir(root, storage.id), "note.txt"),
                  "utf-8"
                )
              )
            )
        );
      }).pipe(Effect.provide(layer))
    );

    expect(note).toBe("kept");
  });

  it("tolerates an in-use cache on evict", async () => {
    const { root, layer } = setup();

    const standing = await Effect.runPromise(
      Effect.gen(function* () {
        const storageService = yield* WorkspaceStorage;
        const workspaces = yield* Workspaces;
        const scope = yield* Scope.make();
        const { storage: files } = yield* workspaces
          .sandbox({ level: "shell" })
          .pipe(Scope.provide(scope));
        // The Sandbox still mounts the cache: evicting it is a no-op, not an error.
        yield* storageService.evict?.(files) ?? Effect.die("no evict");
        const stillThere = existsSync(cacheDir(root, files.id));
        yield* Scope.close(scope, Exit.void);
        return stillThere;
      }).pipe(Effect.provide(layer))
    );

    expect(standing).toBeTruthy();
  });

  it("serializes a checkpoint and the closing save of one Workspace", async () => {
    const inner = memory();
    let active = 0;
    let maxActive = 0;
    let puts = 0;
    const slow: ObjectStore = {
      ...inner,
      put: async (bucket, key, body) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        puts += 1;
        try {
          await delay(50);
          await inner.put(bucket, key, body);
        } finally {
          active -= 1;
        }
      },
    };
    const { root, layer } = setup(slow);

    await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const scope = yield* Scope.make();
        const { sandbox, storage: files } = yield* workspaces
          .sandbox({ level: "shell" })
          .pipe(Scope.provide(scope));
        populate(root, files.id);
        const checkpoint = yield* Effect.forkChild(
          workspaces.save(files, sandbox, "checkpoint")
        );
        yield* Effect.sleep("10 millis");
        // The closing save waits for the checkpoint through the Workspace's lock.
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(checkpoint);
      }).pipe(Effect.provide(layer))
    );

    expect([puts, maxActive]).toStrictEqual([2, 1]);
  });

  it("deletes the snapshot and the cache on discard", async () => {
    const { root, store, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const files = yield* Effect.scoped(
          Effect.gen(function* () {
            const { storage } = yield* workspaces.sandbox({ level: "shell" });
            populate(root, storage.id);
            return storage;
          })
        );
        yield* workspaces.discard(files);
        expect(
          yield* Effect.promise(() => store.list(BUCKET, `${files.id}/`))
        ).toStrictEqual([]);
        expect(existsSync(cacheDir(root, files.id))).toBeFalsy();
      }).pipe(Effect.provide(layer))
    );
  });
});

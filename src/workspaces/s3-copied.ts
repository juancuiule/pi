// Workspace storage as a host-side cache synced through the object store (docs/plans/object-storage.md). A Sandbox
// mounts the cache (a Docker volume) as /workspace; `save` tars it inside the Sandbox and uploads the snapshot to
// the `workspaces` bucket as `<id>/files.tar.zst`, and `restore` streams it back into a fresh Sandbox. The tar
// leaves out `.attachments` and `.skills`, which every Seat copies in again. The cache only lets a remount (an
// Upgrade) skip the download: `evict` deletes it once the Sandbox is gone. Nothing here is Docker-specific but the
// cache, so the adapter carries over to any `Sandboxes` backend whose `env` can exec tar.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Effect, Layer } from "effect";

import * as DockerSandboxes from "../sandbox/docker.ts";
import { Sandboxes, SandboxError } from "../sandbox/sandbox.ts";
import type { SandboxInfo, WorkspaceMount } from "../sandbox/sandbox.ts";
import { BUCKETS } from "../storage/object-store.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { Workspaces, WorkspaceStorage } from "./workspaces.ts";
import type { SaveReason, StorageRef } from "./workspaces.ts";

const ADAPTER = "s3-copied";

const keyOf = (id: string) => `${id}/files.tar.zst`;

// Left out of a snapshot: the copies every Seat makes again (attachments, skills), and what the browser rebuilds —
// its caches (`Cache`, `Code Cache`, `GPUCache`, `ShaderCache`, ...), and its Singleton lock files, which name the
// stopped Sandbox and would make Chrome refuse the profile.
const EXCLUDED = [
  "./.attachments",
  "./.skills",
  "./.browser/Singleton*",
  "./.browser/*Cache",
];

const CHUNK = 8 * 1024 * 1024;

/**
 * The host-side cache a Sandbox mounts as /workspace: a Docker volume in the server, a plain directory in tests.
 * `remove` must fail while a Sandbox still mounts the cache; `evict` reads that failure as the skip signal.
 */
export interface SandboxCache {
  /** Make an empty cache under `id`, the Workspace's storage id. */
  create(id: string): Effect.Effect<void, SandboxError>;
  mount(id: string): WorkspaceMount;
  remove(id: string): Effect.Effect<void, SandboxError>;
}

const inUse = (error: SandboxError) =>
  error.message.includes("in use") ||
  (error.cause instanceof Error && error.cause.message.includes("in use"));

// An evicted cache is gone before Archive's `remove` runs, so a missing one is not an error.
const missing = (error: SandboxError) =>
  error.cause instanceof Error && /no such volume/iu.test(error.cause.message);

const volumeName = (id: string) => `effect-pi-workspace-${id}`;

/** A SandboxCache of Docker named volumes; `labels` are added to every one it creates. */
export const dockerCache = (labels: readonly string[] = []): SandboxCache => ({
  create: (id) =>
    DockerSandboxes.docker([
      "volume",
      "create",
      "--label",
      "effect-pi.workspace",
      ...labels.flatMap((label) => ["--label", label]),
      volumeName(id),
    ]).pipe(Effect.asVoid),
  mount: (id) => ({ type: "volume", name: volumeName(id) }),
  remove: (id) =>
    DockerSandboxes.docker(["volume", "rm", "--force", volumeName(id)]).pipe(
      Effect.asVoid,
      Effect.catchIf(missing, () => Effect.void)
    ),
});

/** The `s3-copied` WorkspaceStorage, over whatever `Sandboxes` the layer below it provides. */
export const layer = (options: {
  readonly store: ObjectStore;
  readonly cache: SandboxCache;
  readonly bucket?: string;
}) =>
  Layer.effect(
    WorkspaceStorage,
    Effect.gen(function* () {
      const sandboxes = yield* Sandboxes;
      const { store } = options;
      const { bucket = BUCKETS.workspaces } = options;

      const restore = Effect.fn("S3Copied.restore")(function* (
        ref: StorageRef,
        sandbox: SandboxInfo
      ) {
        const env = sandboxes.env(sandbox);
        // A populated mount is a remounted cache (an Upgrade, a volume that outlived its Sandbox):
        // it is already newer than any snapshot, so the download is skipped.
        const populated = yield* Effect.tryPromise({
          try: async () =>
            getOrThrow(await env.listDir(env.cwd, BACKGROUND_CONTEXT)).length >
            0,
          catch: (cause) =>
            new SandboxError({
              message: `could not list the workspace of ${sandbox.id}`,
              cause,
            }),
        });
        if (populated) {
          return;
        }
        const tar = `/tmp/effect-pi-restore-${randomUUID().slice(0, 8)}.tar`;
        yield* Effect.tryPromise({
          try: async () => {
            const packed = await store.read(bucket, keyOf(ref.id));
            if (packed === undefined) {
              // No snapshot yet: the Workspace starts empty.
              return;
            }
            try {
              for await (const chunk of packed.pipe(createZstdDecompress())) {
                // oxlint-disable-next-line no-await-in-loop -- the appended chunks must stay in order
                getOrThrow(
                  await env.appendFile(
                    tar,
                    chunk as Uint8Array,
                    BACKGROUND_CONTEXT
                  )
                );
              }
              const extracted = await env.exec(
                `tar xf ${tar} -C ${env.cwd}`,
                {},
                BACKGROUND_CONTEXT
              );
              if (!extracted.ok) {
                throw extracted.error;
              }
              if (extracted.value.exitCode !== 0) {
                throw new Error(`tar xf exited ${extracted.value.exitCode}`);
              }
            } finally {
              try {
                await env.exec(`rm -f ${tar}`, {}, BACKGROUND_CONTEXT);
              } catch {
                // The temporary tar is inside the Sandbox; leaving it is harmless.
              }
            }
          },
          catch: (cause) =>
            new SandboxError({
              message: `could not restore workspace ${ref.id}`,
              cause,
            }),
        });
      });

      const save = Effect.fn("S3Copied.save")(function* (
        ref: StorageRef,
        sandbox: SandboxInfo,
        reason: SaveReason
      ) {
        const env = sandboxes.env(sandbox);
        const tar = `/tmp/effect-pi-${reason}-${randomUUID().slice(0, 8)}.tar`;
        yield* Effect.tryPromise({
          try: async () => {
            try {
              const packed = await env.exec(
                `tar cf ${tar} ${EXCLUDED.map((pattern) => `--exclude='${pattern}'`).join(" ")} -C ${env.cwd} .`,
                {},
                BACKGROUND_CONTEXT
              );
              if (!packed.ok) {
                throw packed.error;
              }
              if (packed.value.exitCode !== 0) {
                throw new Error(`tar cf exited ${packed.value.exitCode}`);
              }
              const reader = getOrThrow(
                await env.openBinaryReader(tar, {}, BACKGROUND_CONTEXT)
              );
              const chunks = (async function* () {
                try {
                  for (let offset = 0; ;) {
                    // oxlint-disable-next-line no-await-in-loop -- positional reads must stay in order
                    const read = await reader.read(
                      offset,
                      CHUNK,
                      BACKGROUND_CONTEXT
                    );
                    const chunk = getOrThrow(read);
                    if (chunk.length === 0) {
                      return;
                    }
                    offset += chunk.length;
                    yield chunk;
                  }
                } finally {
                  await reader.close(BACKGROUND_CONTEXT);
                }
              })();
              await store.put(
                bucket,
                keyOf(ref.id),
                Readable.from(chunks).pipe(createZstdCompress())
              );
            } finally {
              try {
                await env.exec(`rm -f ${tar}`, {}, BACKGROUND_CONTEXT);
              } catch {
                // The temporary tar is inside the Sandbox; leaving it is harmless.
              }
            }
          },
          catch: (cause) =>
            new SandboxError({
              message: `could not save workspace ${ref.id}`,
              cause,
            }),
        });
      });

      return WorkspaceStorage.of({
        adapter: ADAPTER,
        create: Effect.gen(function* () {
          const id = randomUUID();
          yield* options.cache.create(id);
          return { adapter: ADAPTER, id } satisfies StorageRef;
        }),
        remove: (ref) =>
          Effect.tryPromise({
            try: () => store.removePrefix(bucket, `${ref.id}/`),
            catch: (cause) =>
              new SandboxError({
                message: `could not delete workspace ${ref.id}`,
                cause,
              }),
          }).pipe(Effect.andThen(options.cache.remove(ref.id))),
        mount: (ref) => options.cache.mount(ref.id),
        restore,
        save,
        evict: (ref) =>
          // The cache may still be mounted by the Sandbox an Upgrade created over it.
          options.cache
            .remove(ref.id)
            .pipe(Effect.catchIf(inUse, () => Effect.void)),
      });
    })
  );

/** `Workspaces` with Docker Sandboxes over s3-copied storage, as the server runs it under WORKSPACE_STORAGE=s3-copied. */
export const workspaces = (
  options: Parameters<typeof DockerSandboxes.layer>[0] & {
    readonly store: ObjectStore;
    /** Extra labels for the cache volumes, such as one that marks a test's. */
    readonly labels?: readonly string[];
  }
) =>
  Workspaces.layer.pipe(
    Layer.provideMerge(
      layer({ store: options.store, cache: dockerCache(options.labels) })
    ),
    Layer.provide(DockerSandboxes.layer(options))
  );

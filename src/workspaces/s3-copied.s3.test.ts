// s3-copied workspace storage against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// The Sandbox is a local directory; a file past the SDK's 5MB part size exercises the multipart upload.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { s3GatewayUp, s3TestStore } from "../testing/s3.ts";
import { directoryCache, localSandboxes } from "../testing/sandboxes.ts";
import * as S3Copied from "./s3-copied.ts";
import { Workspaces } from "./workspaces.ts";

describe.skipIf(!(await s3GatewayUp()))(
  "s3-copied workspace storage over S3",
  { timeout: 120_000 },
  () => {
    it("saves and restores a Workspace through the gateway", async () => {
      const store = s3TestStore();
      const bucket = `workspaces-test-${randomBytes(8).toString("hex")}`;
      await store.ensure(bucket);
      const local = localSandboxes();
      const root = mkdtempSync(path.join(tmpdir(), "effect-pi-cache-"));
      const layer = Workspaces.layer.pipe(
        Layer.provideMerge(
          S3Copied.layer({
            store,
            cache: directoryCache(root, local.live),
            bucket,
          })
        ),
        Layer.provide(local.sandboxes)
      );

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const workspaces = yield* Workspaces;
            const big = randomBytes(6 * 1024 * 1024);
            const ref = yield* Effect.scoped(
              Effect.gen(function* () {
                const { storage } = yield* workspaces.sandbox({
                  level: "shell",
                });
                const dir = path.join(root, storage.id);
                writeFileSync(path.join(dir, "note.txt"), "kept");
                writeFileSync(path.join(dir, "big.bin"), big);
                return storage;
              })
            );
            expect(existsSync(path.join(root, ref.id))).toBeFalsy();
            yield* Effect.scoped(
              Effect.gen(function* () {
                const { storage } = yield* workspaces.sandbox({
                  level: "shell",
                  storage: ref,
                });
                const dir = path.join(root, storage.id);
                expect(readFileSync(path.join(dir, "note.txt"), "utf-8")).toBe(
                  "kept"
                );
                expect(
                  Buffer.from(readFileSync(path.join(dir, "big.bin"))).equals(
                    big
                  )
                ).toBeTruthy();
              })
            );
            yield* workspaces.discard(ref);
            expect(
              yield* Effect.promise(() => store.list(bucket, `${ref.id}/`))
            ).toStrictEqual([]);
          }).pipe(Effect.provide(layer))
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        await store.drop(bucket);
      }
    });
  }
);

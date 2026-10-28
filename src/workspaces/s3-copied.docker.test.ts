// Measurement for s3-copied workspace storage (docs/adr/0006-object-storage-beside-local-sqlite.md): a ~190MB workspace, three
// save+restore cycles through the real SeaweedFS gateway and real Docker sandboxes, with the tar/untar
// phases timed separately from the save/restore calls so the report can say what limits them.
// Run with `pnpm test:docker` after `pnpm sandbox:build` and `pnpm seaweed:up`.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import * as DockerSandboxes from "../sandbox/docker.ts";
import { dockerAvailable } from "../sandbox/docker.ts";
import { Sandboxes } from "../sandbox/sandbox.ts";
import type { SandboxInfo } from "../sandbox/sandbox.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { s3GatewayUp, s3TestStore } from "../testing/s3.ts";
import * as S3Copied from "./s3-copied.ts";
import { WorkspaceStorage } from "./workspaces.ts";

const TEST_LABEL = "effect-pi.test";

// ~190MB: 3000 small package-like files (2-8KB of base64'd random data) plus three 60MB binaries, a
// plausible size for a development workspace's node_modules-heavy tree.
const POPULATE = `
set -e
mkdir -p node_modules
for d in $(seq 1 60); do
  mkdir -p node_modules/pkg$d
  for f in $(seq 1 50); do
    head -c $((1024 + RANDOM % 4096)) /dev/urandom | base64 > node_modules/pkg$d/f$f.js
  done
done
head -c 60M /dev/urandom > big1.bin
head -c 60M /dev/urandom > big2.bin
head -c 60M /dev/urandom > big3.bin
`;

const run = (env: ExecutionEnv, command: string) =>
  Effect.promise(async () => {
    let text = "";
    const result = await env.exec(
      command,
      { onOutput: (chunk) => (text += chunk) },
      BACKGROUND_CONTEXT
    );
    if (!result.ok) {
      throw result.error;
    }
    if (result.value.exitCode !== 0) {
      throw new Error(`exited ${result.value.exitCode}: ${text}`);
    }
    return text.trim();
  });

const timed = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const started = Date.now();
    const value = yield* effect;
    return { ms: Date.now() - started, value };
  });

describe.skipIf(!(await dockerAvailable()) || !(await s3GatewayUp()))(
  "s3-copied save/restore measurement",
  { timeout: 900_000 },
  () => {
    const bucket = `measure-${randomBytes(8).toString("hex")}`;
    let store: ObjectStore;

    afterAll(async () => {
      const volumes = execFileSync(
        "docker",
        ["volume", "ls", "--filter", `label=${TEST_LABEL}`, "-q"],
        { encoding: "utf-8" }
      )
        .split("\n")
        .filter((name) => name !== "");
      if (volumes.length > 0) {
        execFileSync("docker", ["volume", "rm", "--force", ...volumes]);
      }
      await store?.drop(bucket);
    });

    it("times save and restore over three cycles", async () => {
      store = s3TestStore();
      await store.ensure(bucket);
      const layer = S3Copied.layer({
        store,
        cache: S3Copied.dockerCache([TEST_LABEL]),
        bucket,
      }).pipe(Layer.provideMerge(DockerSandboxes.layer()));

      const rows: Record<string, number | string>[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes;
          const storage = yield* WorkspaceStorage;
          const ref = yield* storage.create;
          const create = () =>
            sandboxes.create(
              "shell",
              `effect-pi-measure-${randomBytes(4).toString("hex")}`,
              storage.mount(ref),
              []
            );
          const cleanup = (sandbox: SandboxInfo) =>
            sandboxes
              .remove(sandbox)
              .pipe(Effect.andThen(storage.evict?.(ref) ?? Effect.void));
          const packed = () =>
            Effect.promise(() => store.list(bucket, `${ref.id}/`));

          let sandbox = yield* create();
          let env = sandboxes.env(sandbox);
          yield* run(env, POPULATE);
          const payloadBytes = Number(
            yield* run(env, "du -sb /workspace | cut -f1")
          );

          for (let cycle = 1; cycle <= 3; cycle += 1) {
            // The tar the save runs, timed on its own to split packing from reading+uploading.
            const tar = yield* timed(
              run(
                env,
                "tar cf /tmp/probe.tar --exclude=./.attachments --exclude=./.skills -C /workspace . && stat -c%s /tmp/probe.tar"
              )
            );
            const tarBytes = Number(tar.value);
            const save = yield* timed(
              storage.save?.(ref, sandbox, "pause") ?? Effect.void
            );
            yield* run(env, "mkdir -p /tmp/probe-out");
            const untar = yield* timed(
              run(
                env,
                "tar xf /tmp/probe.tar -C /tmp/probe-out && rm -rf /tmp/probe-out /tmp/probe.tar"
              )
            );
            const snapshot = yield* packed();
            yield* cleanup(sandbox);
            sandbox = yield* create();
            env = sandboxes.env(sandbox);
            const restore = yield* timed(
              storage.restore?.(ref, sandbox) ?? Effect.void
            );
            const restored = Number(
              yield* run(env, "stat -c%s /workspace/big1.bin")
            );
            rows.push({
              run: cycle,
              payloadMB: Math.round(payloadBytes / 1e6),
              tarMB: Math.round(tarBytes / 1e6),
              packedMB: Math.round((snapshot[0]?.size ?? 0) / 1e6),
              tarMs: tar.ms,
              untarMs: untar.ms,
              saveMs: save.ms,
              restoreMs: restore.ms,
              restoredMB: Math.round(restored / 1e6),
            });
            expect(restored).toBe(60 * 1024 * 1024);
          }
          yield* cleanup(sandbox);
        }).pipe(Effect.provide(layer), Effect.scoped)
      );

      console.log(
        "\ns3-copied measurement (~190MB workspace, incompressible data)"
      );
      console.table(rows);
    });
  }
);

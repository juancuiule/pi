// Test helper: Sandboxes backed by temporary local directories, so pi's real file and shell tools run without Docker.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect, Layer } from "effect";

import { Sandboxes } from "../sandbox/sandbox.ts";
import type { SandboxInfo, SandboxKind } from "../sandbox/sandbox.ts";

export interface LocalSandboxes {
  readonly layer: Layer.Layer<Sandboxes>;
  /** Sandboxes created and not yet removed, by directory. */
  readonly live: Set<string>;
}

export const localSandboxes = (): LocalSandboxes => {
  const live = new Set<string>();
  const layer = Layer.succeed(
    Sandboxes,
    Sandboxes.of({
      create: (kind: SandboxKind, name: string) =>
        Effect.sync(() => {
          const dir = mkdtempSync(path.join(tmpdir(), `${name}-`));
          live.add(dir);
          return { kind, id: dir } satisfies SandboxInfo;
        }),
      remove: (sandbox: SandboxInfo) =>
        Effect.sync(() => {
          rmSync(sandbox.id, { recursive: true, force: true });
          live.delete(sandbox.id);
        }),
      env: (sandbox: SandboxInfo) => new NodeExecutionEnv({ cwd: sandbox.id }),
    })
  );
  return { layer, live };
};

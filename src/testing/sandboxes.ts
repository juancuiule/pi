// Test helpers: Sandboxes that run in local directories, so pi's real file and shell tools run without Docker, and
// Workspace storage as temporary directories that those Sandboxes use as their working directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect, Layer } from "effect";

import { Sandboxes } from "../sandbox/sandbox.ts";
import type {
  SandboxInfo,
  SandboxKind,
  WorkspaceMount,
} from "../sandbox/sandbox.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import { Workspaces, WorkspaceStorage } from "../workspaces/workspaces.ts";
import type { StorageRef } from "../workspaces/workspaces.ts";

export interface LocalSandboxes {
  /** `Workspaces` over local Sandboxes and directory storage. */
  readonly layer: Layer.Layer<Workspaces>;
  /** Sandboxes created and not yet removed, by working directory. */
  readonly live: Set<string>;
  /** Workspace storage directories created and not yet removed. */
  readonly stored: Set<string>;
  /** Every Sandbox created, in order: its Level and the Software asked for. */
  readonly created: {
    readonly kind: SandboxKind;
    readonly software: readonly SoftwareId[];
  }[];
}

export const localSandboxes = (
  options: {
    /** Runs inside `create` before the Sandbox exists — a stand-in for a slow image build. */
    readonly onCreate?: Effect.Effect<void>;
  } = {}
): LocalSandboxes => {
  const live = new Set<string>();
  const stored = new Set<string>();
  const created: LocalSandboxes["created"] = [];
  // A Sandbox's id is its working directory: the Workspace's directory.
  const sandboxes = Layer.succeed(
    Sandboxes,
    Sandboxes.of({
      create: (
        kind: SandboxKind,
        _name: string,
        files: WorkspaceMount,
        software: readonly SoftwareId[]
      ) =>
        files.type === "directory"
          ? (options.onCreate ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  live.add(files.path);
                  created.push({ kind, software: [...software] });
                  return { kind, id: files.path } satisfies SandboxInfo;
                })
              )
            )
          : Effect.die(new Error("Local sandboxes mount directories only")),
      remove: (sandbox: SandboxInfo) =>
        Effect.sync(() => {
          live.delete(sandbox.id);
        }),
      env: (sandbox: SandboxInfo) => new NodeExecutionEnv({ cwd: sandbox.id }),
    })
  );
  const storage = Layer.succeed(
    WorkspaceStorage,
    WorkspaceStorage.of({
      create: Effect.sync(() => {
        const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-workspace-"));
        stored.add(dir);
        return { adapter: "directory", id: dir } satisfies StorageRef;
      }),
      remove: (ref) =>
        Effect.sync(() => {
          rmSync(ref.id, { recursive: true, force: true });
          stored.delete(ref.id);
        }),
      mount: (ref) => ({ type: "directory", path: ref.id }),
    })
  );
  return {
    layer: Workspaces.layer.pipe(
      Layer.provide(Layer.merge(sandboxes, storage))
    ),
    live,
    stored,
    created,
  };
};

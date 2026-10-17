// Test helpers: Sandboxes that run in local directories, so pi's real file and shell tools run without Docker, and
// Workspace storage as temporary directories that those Sandboxes use as their working directory.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NodeStream } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { Sandboxes, SandboxError } from "../sandbox/sandbox.ts";
import type {
  SandboxInfo,
  SandboxKind,
  SandboxShell,
  WorkspaceMount,
} from "../sandbox/sandbox.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import type { SandboxCache } from "../workspaces/s3-copied.ts";
import { Workspaces, WorkspaceStorage } from "../workspaces/workspaces.ts";
import type { StorageRef } from "../workspaces/workspaces.ts";

export interface LocalSandboxes {
  /** `Workspaces` over local Sandboxes and directory storage. */
  readonly layer: Layer.Layer<Workspaces>;
  /** The inner layers, for composing a different WorkspaceStorage over the same Sandboxes. */
  readonly sandboxes: Layer.Layer<Sandboxes>;
  readonly storage: Layer.Layer<WorkspaceStorage>;
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
    /** Runs inside `create` before the Sandbox exists — a stand-in for a slow or failing image build. */
    readonly onCreate?: Effect.Effect<void, SandboxError>;
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
                // Like a volume mount, mounting a missing directory creates it.
                Effect.sync(() => {
                  mkdirSync(files.path, { recursive: true });
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
      // pty.spawn runs the shell under a real PTY, so echo, Ctrl-C and `exit` behave like the Docker
      // Sandboxes'. Its PTY size is unreachable from outside: `resize` does nothing.
      shell: (
        sandbox: SandboxInfo,
        _options: { columns: number; rows: number }
      ) =>
        Effect.gen(function* () {
          const child = spawn(
            "python3",
            ["-c", 'import pty; pty.spawn(["bash", "-l"])'],
            {
              cwd: sandbox.id,
              env: { ...process.env, TERM: "xterm-256color" },
              stdio: ["pipe", "pipe", "pipe"],
            }
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              child.kill("SIGKILL");
            })
          );
          const { stdin, stdout } = child;
          if (stdin === null || stdout === null) {
            return yield* new SandboxError({
              message: "the local shell did not get its pipes",
            });
          }
          const output = NodeStream.fromReadable<Uint8Array, SandboxError>({
            evaluate: () => stdout,
            onError: (cause) =>
              new SandboxError({
                message: "the sandbox shell's stream failed",
                cause,
              }),
          });
          const writeTo = promisify(
            (bytes: Uint8Array, done: (error?: Error | null) => void) =>
              stdin.write(bytes, done)
          );
          const write = (bytes: Uint8Array) =>
            Effect.promise(() => writeTo(bytes)).pipe(
              Effect.mapError(
                (cause) =>
                  new SandboxError({
                    message: "writing to the sandbox shell failed",
                    cause,
                  })
              )
            );
          return {
            output,
            write,
            resize: () => Effect.void,
          } satisfies SandboxShell;
        }),
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
    sandboxes,
    storage,
    live,
    stored,
    created,
  };
};

/**
 * A `SandboxCache` over host directories under `root`, for testing s3-copied storage. `live` is a
 * `LocalSandboxes`' set: removing a cache a Sandbox still mounts fails with an "in use" error, the way a
 * mounted Docker volume refuses `volume rm`.
 */
export const directoryCache = (
  root: string,
  live: Set<string>
): SandboxCache => {
  const dir = (id: string) => path.join(root, id);
  return {
    create: (id) =>
      Effect.sync(() => {
        mkdirSync(dir(id), { recursive: true });
      }),
    mount: (id) => ({ type: "directory", path: dir(id) }),
    remove: (id) =>
      live.has(dir(id))
        ? new SandboxError({ message: `cache ${id} is in use` })
        : Effect.sync(() => {
            rmSync(dir(id), { recursive: true, force: true });
          }),
  };
};

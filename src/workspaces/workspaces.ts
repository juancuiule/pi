// Workspaces: the durable machine side of a Conversation, its Level and its files (see GLOSSARY.md). A Workspace's
// files live in storage behind a `WorkspaceStorage` adapter; a Sandbox is a running machine over them, created for a
// Seat and removed when the Seat ends, while the files stay for the next one.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import { Sandboxes } from "../sandbox/sandbox.ts";
import type {
  SandboxChoice,
  SandboxError,
  SandboxInfo,
  SandboxKind,
  SandboxShell,
  WorkspaceMount,
} from "../sandbox/sandbox.ts";

/**
 * Where a Workspace's files are, as the adapter that created them recorded it. Opaque outside that adapter, so a
 * distributed one (an object store, a network filesystem) can record what it needs.
 */
// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type StorageRef = { readonly adapter: string; readonly id: string };

// oxlint-disable-next-line typescript/consistent-type-definitions
export type WorkspaceState = {
  level: SandboxChoice;
  /** Set once the Workspace first has a Sandbox; a Workspace at Level `none` has no files. */
  storage?: StorageRef;
};

/** A Conversation's Workspace. Its Level only goes up; Archive drops `storage`. */
export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ level: "none" }),
});

/**
 * Where Workspace files are stored. This adapter mounts them into a Sandbox; one that copies files in and out instead
 * would add a restore and a save around the Sandbox's life.
 */
export class WorkspaceStorage extends Context.Service<
  WorkspaceStorage,
  {
    /** Make empty storage for a new Workspace. */
    readonly create: Effect.Effect<StorageRef, SandboxError>;
    /** Delete a Workspace's files, ignoring ones already gone. */
    remove(storage: StorageRef): Effect.Effect<void, SandboxError>;
    /** How a Sandbox mounts these files. */
    mount(storage: StorageRef): WorkspaceMount;
  }
>()("effect-pi/WorkspaceStorage") {}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * A Sandbox at `level` over the Workspace's files, removed when the scope closes; the files stay. Creates the
     * storage when the Workspace has none yet: `storage` is what to record in its `WorkspaceDoc`.
     */
    sandbox(workspace: {
      readonly level: SandboxKind;
      readonly storage?: StorageRef | undefined;
    }): Effect.Effect<
      { readonly sandbox: SandboxInfo; readonly storage: StorageRef },
      SandboxError,
      Scope.Scope
    >;
    /** Delete a Workspace's files, for Archive. */
    discard(storage: StorageRef): Effect.Effect<void, SandboxError>;
    /** The execution environment of a Sandbox, for the harness; cheap, called for every tool call. */
    env(sandbox: SandboxInfo): ExecutionEnv;
    /**
     * A live interactive shell in a Sandbox, ending when its scope closes; unlike `env`, it is a
     * real PTY, not a request/reply channel, so it is not for tool calls.
     */
    shell(
      sandbox: SandboxInfo,
      size: { readonly columns: number; readonly rows: number }
    ): Effect.Effect<SandboxShell, SandboxError, Scope.Scope>;
  }
>()("effect-pi/Workspaces") {
  static readonly layer = Layer.effect(
    Workspaces,
    Effect.gen(function* () {
      const sandboxes = yield* Sandboxes;
      const storage = yield* WorkspaceStorage;

      const sandbox = Effect.fn("Workspaces.sandbox")(function* (workspace: {
        readonly level: SandboxKind;
        readonly storage?: StorageRef | undefined;
      }) {
        const files = workspace.storage ?? (yield* storage.create);
        const created = yield* Effect.acquireRelease(
          sandboxes.create(
            workspace.level,
            `effect-pi-${workspace.level}-${crypto.randomUUID().slice(0, 8)}`,
            storage.mount(files)
          ),
          (running) => Effect.ignore(sandboxes.remove(running))
        ).pipe(
          // New storage that never got a Sandbox is never recorded, so it is removed instead of leaking.
          Effect.onError(() =>
            workspace.storage === undefined
              ? Effect.ignore(storage.remove(files))
              : Effect.void
          )
        );
        return { sandbox: created, storage: files };
      });

      return Workspaces.of({
        sandbox,
        discard: storage.remove,
        env: sandboxes.env,
        shell: sandboxes.shell,
      });
    })
  );
}

// Workspaces: the durable machine side of a Conversation, its Level, its Software and its files (see GLOSSARY.md).
// A Workspace's files live in storage behind a `WorkspaceStorage` adapter; a Sandbox is a running machine over them,
// created for a Seat and removed when the Seat ends, while the files stay for the next one.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Exit, Layer, Ref, Semaphore } from "effect";
import type { Scope } from "effect";

import { Sandboxes } from "../sandbox/sandbox.ts";
import type {
  SandboxChoice,
  SandboxError,
  SandboxInfo,
  SandboxKind,
  WorkspaceMount,
} from "../sandbox/sandbox.ts";
import type { ShellSession } from "../sandbox/shell-session.ts";
import { shellSession } from "../sandbox/shell-session.ts";
import type { SoftwareId } from "../sandbox/software.ts";

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
  /** In catalog order; absent is none. Like the Level, it only grows. */
  software?: SoftwareId[];
  /** Set once the Workspace first has a Sandbox; a Workspace at Level `none` has no files. */
  storage?: StorageRef;
};

/** A Conversation's Workspace. Its Level and Software only grow; Archive drops `storage`. */
export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ level: "none" }),
});

/** Why a Workspace is being saved: its Seat ended, or a Run did (a checkpoint bounding what a crash loses). */
export type SaveReason = "pause" | "checkpoint";

/**
 * Where Workspace files are stored. This adapter mounts them into a Sandbox; an adapter that copies files in and
 * out instead (its mount being a cache) also implements `restore`, `save` and `evict`.
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
    /**
     * Copy the Workspace's files into a Sandbox that just started; a failure fails the Sandbox's open.
     * Absent for adapters whose mount is the storage itself.
     */
    restore?(
      storage: StorageRef,
      sandbox: SandboxInfo
    ): Effect.Effect<void, SandboxError>;
    /**
     * Copy the Sandbox's /workspace back to storage. Absent for adapters whose mount is the storage
     * itself.
     */
    save?(
      storage: StorageRef,
      sandbox: SandboxInfo,
      reason: SaveReason
    ): Effect.Effect<void, SandboxError>;
    /** Free host-side state the mount needed (a cache volume) once its Sandbox is gone. */
    evict?(storage: StorageRef): Effect.Effect<void, SandboxError>;
  }
>()("effect-pi/WorkspaceStorage") {}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * A Sandbox at `level`, with `software`, over the Workspace's files, removed when the scope closes; the files
     * stay. Creates the storage when the Workspace has none yet: `storage` is what to record in its `WorkspaceDoc`.
     */
    sandbox(workspace: {
      readonly level: SandboxKind;
      readonly software?: readonly SoftwareId[] | undefined;
      readonly storage?: StorageRef | undefined;
    }): Effect.Effect<
      { readonly sandbox: SandboxInfo; readonly storage: StorageRef },
      SandboxError,
      Scope.Scope
    >;
    /**
     * Copy the Sandbox's files back to storage; a no-op when the adapter mounts storage directly. Saves
     * of one Workspace serialize, so a Run's checkpoint and a Seat's closing save never overlap.
     */
    save(
      storage: StorageRef,
      sandbox: SandboxInfo,
      reason: SaveReason
    ): Effect.Effect<void, SandboxError>;
    /** Delete a Workspace's files, for Archive. */
    discard(storage: StorageRef): Effect.Effect<void, SandboxError>;
    /** The execution environment of a Sandbox, for the harness; cheap, called for every tool call. */
    env(sandbox: SandboxInfo): ExecutionEnv;
    /**
     * A persistent interactive shell session in a Sandbox, ending when its scope closes; unlike `env`,
     * it is a real PTY, not a request/reply channel, so it is not for tool calls. Each run of the
     * session's `output` replays recent scrollback then follows live — callers attach and detach
     * freely — and `alive` reports the PTY's end so the owner can start a fresh session.
     */
    shell(
      sandbox: SandboxInfo,
      size: { readonly columns: number; readonly rows: number }
    ): Effect.Effect<ShellSession, SandboxError, Scope.Scope>;
  }
>()("effect-pi/Workspaces") {
  static readonly layer = Layer.effect(
    Workspaces,
    Effect.gen(function* () {
      const sandboxes = yield* Sandboxes;
      const storage = yield* WorkspaceStorage;
      // One lock per Workspace serializes its saves; a closing save taking the lock also joins a
      // checkpoint still running, so the Sandbox is never removed mid-save.
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (ref: StorageRef) => {
        const key = `${ref.adapter}:${ref.id}`;
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock;
      };

      const save = Effect.fn("Workspaces.save")(function* (
        ref: StorageRef,
        running: SandboxInfo,
        reason: SaveReason
      ) {
        if (storage.save === undefined) {
          return;
        }
        yield* storage.save(ref, running, reason).pipe(lockFor(ref).withPermit);
      });

      const sandbox = Effect.fn("Workspaces.sandbox")(function* (workspace: {
        readonly level: SandboxKind;
        readonly software?: readonly SoftwareId[] | undefined;
        readonly storage?: StorageRef | undefined;
      }) {
        const files = workspace.storage ?? (yield* storage.create);
        // A failed restore leaves the mount half-populated; `restored` keeps the release from saving
        // that over a good snapshot.
        const restored = yield* Ref.make(storage.restore === undefined);
        const created = yield* Effect.acquireRelease(
          sandboxes.create(
            workspace.level,
            `effect-pi-${workspace.level}-${crypto.randomUUID().slice(0, 8)}`,
            storage.mount(files),
            workspace.software ?? []
          ),
          (running) =>
            Effect.gen(function* () {
              let keepCache = false;
              if ((yield* Ref.get(restored)) && storage.save !== undefined) {
                const saved = yield* Effect.exit(save(files, running, "pause"));
                if (Exit.isFailure(saved)) {
                  yield* Effect.logWarning(
                    `Could not save workspace ${files.id}`,
                    saved.cause
                  );
                  // The cache still holds the files the failed save could not put away.
                  keepCache = true;
                }
              }
              yield* Effect.ignore(sandboxes.remove(running));
              if (!keepCache && storage.evict !== undefined) {
                yield* storage
                  .evict(files)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Could not evict the cache of workspace ${files.id}`,
                        cause
                      )
                    )
                  );
              }
            })
        ).pipe(
          Effect.tap((running) =>
            storage.restore === undefined
              ? Effect.void
              : storage
                  .restore(files, running)
                  .pipe(Effect.andThen(Ref.set(restored, true)))
          ),
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
        save,
        discard: storage.remove,
        env: sandboxes.env,
        shell: (info, size) =>
          Effect.flatMap(sandboxes.shell(info, size), shellSession),
      });
    })
  );
}

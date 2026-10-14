// Workspace storage as local Docker named volumes, mounted at /workspace by the Docker Sandboxes. A volume outlives
// the containers that mount it, so a paused Conversation's files wait for its next Sandbox, of any Level.
import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import * as DockerSandboxes from "../sandbox/docker.ts";
import { docker } from "../sandbox/docker.ts";
import { Workspaces, WorkspaceStorage } from "./workspaces.ts";
import type { StorageRef } from "./workspaces.ts";

const ADAPTER = "docker-volume";

/** Docker volume storage; `labels` are added to every volume it creates, beside `effect-pi.workspace`. */
export const storage = (labels: readonly string[] = []) =>
  WorkspaceStorage.of({
    create: Effect.gen(function* () {
      const name = `effect-pi-workspace-${randomUUID().slice(0, 8)}`;
      yield* docker([
        "volume",
        "create",
        "--label",
        "effect-pi.workspace",
        ...labels.flatMap((label) => ["--label", label]),
        name,
      ]);
      return { adapter: ADAPTER, id: name } satisfies StorageRef;
    }),
    remove: (ref) =>
      docker(["volume", "rm", "--force", ref.id]).pipe(Effect.asVoid),
    mount: (ref) => ({ type: "volume", name: ref.id }),
  });

export const layer = Layer.succeed(WorkspaceStorage, storage());

/** `Workspaces` with Docker Sandboxes over Docker volumes, as the server runs them. */
export const workspaces = (
  options: Parameters<typeof DockerSandboxes.layer>[0] & {
    /** Extra labels for the volumes, such as one that marks a test's. */
    readonly labels?: readonly string[];
  } = {}
) =>
  Workspaces.layer.pipe(
    Layer.provide(
      Layer.merge(
        DockerSandboxes.layer(options),
        Layer.succeed(WorkspaceStorage, storage(options.labels))
      )
    )
  );

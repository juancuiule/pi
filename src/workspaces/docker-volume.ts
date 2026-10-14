// Workspace storage as local Docker named volumes, mounted at /workspace by the Docker Sandboxes. A volume outlives
// the containers that mount it, so a paused Conversation's files wait for its next Sandbox, of any Level.
import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import * as DockerSandboxes from "../sandbox/docker.ts";
import { docker } from "../sandbox/docker.ts";
import { Workspaces, WorkspaceStorage } from "./workspaces.ts";
import type { StorageRef } from "./workspaces.ts";

const ADAPTER = "docker-volume";

export const layer = Layer.succeed(
  WorkspaceStorage,
  WorkspaceStorage.of({
    create: Effect.gen(function* () {
      const name = `effect-pi-workspace-${randomUUID().slice(0, 8)}`;
      yield* docker([
        "volume",
        "create",
        "--label",
        "effect-pi.workspace",
        name,
      ]);
      return { adapter: ADAPTER, id: name } satisfies StorageRef;
    }),
    remove: (storage) =>
      docker(["volume", "rm", "--force", storage.id]).pipe(Effect.asVoid),
    mount: (storage) => ({ type: "volume", name: storage.id }),
  })
);

/** `Workspaces` with Docker Sandboxes over Docker volumes, as the server runs them. */
export const workspaces = (
  options: Parameters<typeof DockerSandboxes.layer>[0] = {}
) =>
  Workspaces.layer.pipe(
    Layer.provide(Layer.merge(DockerSandboxes.layer(options), layer))
  );

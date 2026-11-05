import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { MetaDoc } from "../conversation-meta.ts";
import { memory } from "../storage/object-store.ts";
import { fauxAgents } from "../testing/faux.ts";
import { directoryCache, localSandboxes } from "../testing/sandboxes.ts";
import * as S3Copied from "../workspaces/s3-copied.ts";
import { WorkspaceDoc, Workspaces } from "../workspaces/workspaces.ts";
import type { StorageRef } from "../workspaces/workspaces.ts";
import { Agents } from "./agents.ts";

const open = async (file: string) =>
  await Harness.open(
    await openNodeSqliteStorage(file),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT
  );

const seed = async (file: string, storage: StorageRef) => {
  const harness = await open(file);
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const meta = await tx.doc(MetaDoc, id);
        meta.meta = { title: "From before s3-copied", createdAt: 0 };
        const workspace = await tx.doc(WorkspaceDoc, id);
        workspace.level = "shell";
        workspace.storage = storage;
      },
    },
    BACKGROUND_CONTEXT
  );
  await harness.close(BACKGROUND_CONTEXT);
  return created.id;
};

const recorded = async (file: string, id: ConversationId) => {
  const harness = await open(file);
  const doc = await harness.snapshot(WorkspaceDoc, id, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  return doc?.storage;
};

describe("Agents startup", () => {
  it("moves Workspaces to the configured adapter when it can take them over", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "adoption-"));
    const file = path.join(dir, "db.sqlite");
    const local = localSandboxes();
    const layer = Workspaces.layer.pipe(
      Layer.provideMerge(
        S3Copied.layer({
          store: memory(),
          cache: directoryCache(dir, local.live),
        })
      ),
      Layer.provide(local.sandboxes)
    );
    const boot = async () => {
      const storage = await openNodeSqliteStorage(file);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Agents;
          })
        ).pipe(
          Effect.provide(
            fauxAgents([], {
              storage,
              sandboxes: { ...local, layer },
            }).layer
          )
        )
      );
    };

    const volume = await seed(file, {
      adapter: "docker-volume",
      id: "effect-pi-workspace-1d91d804",
    });
    const unknown = await seed(file, { adapter: "elsewhere", id: "x" });

    await boot();
    const first = {
      volume: await recorded(file, volume),
      unknown: await recorded(file, unknown),
    };
    await boot();
    const second = await recorded(file, volume);
    rmSync(dir, { recursive: true, force: true });

    expect(first).toStrictEqual({
      volume: { adapter: "s3-copied", id: "1d91d804" },
      unknown: { adapter: "elsewhere", id: "x" },
    });
    expect(second).toStrictEqual(first.volume);
  });
});

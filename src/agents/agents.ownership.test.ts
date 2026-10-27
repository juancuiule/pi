import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { UserId } from "../auth/user.ts";
import { MetaDoc } from "../conversation-meta.ts";
import { fauxAgents } from "../testing/faux.ts";
import { alice, bob } from "../testing/users.ts";
import { Agents } from "./agents.ts";

const create = (owner: UserId) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.create({
      prompt: "",
      title: "",
      level: "none",
      createdAt: 0,
      owner,
    });
  });

/** A Conversation recorded the way the app did before accounts: its meta has a title and no owner. */
const seedLegacy = async (file: string) => {
  const harness = await Harness.open(
    await openNodeSqliteStorage(file),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT
  );
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const doc = await tx.doc(MetaDoc, id);
        doc.meta = { title: "From before accounts", createdAt: 0 };
      },
    },
    BACKGROUND_CONTEXT
  );
  await harness.close(BACKGROUND_CONTEXT);
  return created.id;
};

describe("Agents ownership", () => {
  it("records the owner in the creating commit, and adopts only what has none", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ownership-"));
    const file = path.join(dir, "db.sqlite");
    const legacy = await seedLegacy(file);
    const storage = await openNodeSqliteStorage(file);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const mine = yield* create(alice.id);
          const before = {
            mine: yield* agents.ownerOf(mine),
            legacy: yield* agents.ownerOf(legacy),
          };
          const adopted = yield* agents.adopt(bob.id);
          const again = yield* agents.adopt(alice.id);
          return {
            before,
            adopted,
            again,
            after: {
              mine: yield* agents.ownerOf(mine),
              legacy: yield* agents.ownerOf(legacy),
            },
            unknown: yield* agents.ownerOf(9999 as typeof mine),
          };
        })
      ).pipe(Effect.provide(fauxAgents([], { storage }).layer))
    ).finally(() => rmSync(dir, { recursive: true, force: true }));
    expect(result).toStrictEqual({
      before: { mine: alice.id, legacy: undefined },
      adopted: 1,
      again: 0,
      after: { mine: alice.id, legacy: bob.id },
      unknown: undefined,
    });
  });
});

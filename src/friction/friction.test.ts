// The friction log: the agent's tools file and note entries across conversations, the person triages them, and the
// cap never drops an entry the person has not triaged.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { ask, callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { addEntry, MAX_ENTRIES, noteEntry, triageEntry } from "./friction.ts";
import type { FrictionInput, FrictionState } from "./friction.ts";

const input: FrictionInput = {
  scope: "project",
  title: "pnpm test ignores --filter",
  whatHappened: "pnpm test --filter web ran every package",
  expectedOrWhyItHurt: "Only web's tests; the full run takes four minutes",
};

const empty = (): FrictionState => ({ entries: [], next: 1 });

describe("the friction log", () => {
  it("never reuses an id, even after the cap drops an entry", () => {
    const state = empty();
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      addEntry(state, input, 1, i);
    }
    triageEntry(state, "f2", "dismissed");
    const added = addEntry(state, input, 1, 0);
    expect(added?.id).toBe(`f${MAX_ENTRIES + 1}`);
    expect(state.entries).toHaveLength(MAX_ENTRIES);
    expect(state.entries.some((entry) => entry.id === "f2")).toBeFalsy();
  });

  it("refuses a new entry when every kept entry is still open", () => {
    const state = empty();
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      addEntry(state, input, 1, i);
    }
    expect(addEntry(state, input, 1, 0)).toBeUndefined();
    expect(state.entries).toHaveLength(MAX_ENTRIES);
  });

  it("reopens a resolved entry on a new note and leaves a dismissed one dismissed", () => {
    const state = empty();
    addEntry(state, input, 1, 0);
    addEntry(state, input, 1, 0);
    triageEntry(state, "f1", "resolved");
    triageEntry(state, "f2", "dismissed");
    expect(noteEntry(state, "f1", "again", 2, 1)?.status).toBe("open");
    expect(noteEntry(state, "f2", "again", 2, 1)?.status).toBe("dismissed");
    expect(noteEntry(state, "f9", "again", 2, 1)).toBeUndefined();
  });
});

const finish = fauxAssistantMessage([fauxText("done")]);

describe("the friction tools", () => {
  it("file from one conversation, note from another, and the person triages", async () => {
    const { layer } = fauxAgents([
      callTool("friction_add", { ...input }),
      finish,
      callTool("friction_note", { id: "f1", note: "Hit it again" }),
      finish,
      callTool("friction_list", {}),
      echoToolResult,
    ]);
    const { listed, log, triaged, missing } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ask("run the web tests");
        yield* ask("run them again");
        const answer = yield* ask("what friction is logged?");
        const agents = yield* Agents;
        const entries = yield* agents.friction;
        const resolved = yield* agents.triageFriction("f1", "resolved");
        const unknown = yield* Effect.flip(
          agents.triageFriction("f9", "dismissed")
        );
        return {
          listed: JSON.parse(answer) as unknown,
          log: entries,
          triaged: resolved,
          missing: unknown,
        };
      }).pipe(Effect.provide(layer))
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: "f1",
      scope: "project",
      title: input.title,
      status: "open",
      notes: [{ text: "Hit it again" }],
    });
    expect(log[0]?.notes[0]?.conversationId).not.toBe(log[0]?.conversationId);
    expect(listed).toStrictEqual({
      entries: [
        {
          id: "f1",
          scope: "project",
          status: "open",
          title: input.title,
          whatHappened: input.whatHappened,
          notes: 1,
        },
      ],
    });
    expect([triaged.status, missing._tag]).toStrictEqual([
      "resolved",
      "FrictionNotFound",
    ]);
  });

  it("tells the model when a note names no entry", async () => {
    const { layer } = fauxAgents([
      callTool("friction_note", { id: "f7", note: "again" }),
      echoToolResult,
    ]);
    const answer = await Effect.runPromise(
      ask("note it").pipe(Effect.provide(layer))
    );
    expect(answer).toMatch(/^error: /u);
    expect(answer).toContain(
      "No friction entry f7; call friction_list for ids."
    );
  });

  it("keeps the log and its triage across a restart", async () => {
    const dbFile = path.join(
      mkdtempSync(path.join(tmpdir(), "friction-")),
      "db.sqlite"
    );
    const run = <A, E>(
      responses: Parameters<typeof fauxAgents>[0],
      program: Effect.Effect<A, E, Agents>
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Effect.promise(() =>
              openNodeSqliteStorage(dbFile)
            );
            return yield* program.pipe(
              Effect.provide(fauxAgents(responses, { storage }).layer)
            );
          })
        )
      );
    await run(
      [callTool("friction_add", { ...input }), finish],
      ask("run the web tests").pipe(
        Effect.andThen(
          Agents.use((agents) => agents.triageFriction("f1", "dismissed"))
        )
      )
    );
    const log = await run(
      [],
      Agents.use((agents) => agents.friction)
    );
    expect(log).toMatchObject([{ id: "f1", status: "dismissed" }]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { callTool, fauxAgents } from "../testing/faux.ts";
import { Search } from "./search.ts";

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

const setup = (responses: FauxResponseStep[]) => {
  const agents = fauxAgents(responses);
  return {
    agents,
    // provideMerge: the test sees the same Agents the Search is built over.
    layer: Search.temporary.pipe(Layer.provideMerge(agents.layer)),
  };
};

/** Record a conversation titled `title` and run one prompt through it. */
const converse = (title: string, prompt: string, createdAt = Date.now()) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const id = yield* agents.create({
      prompt: "",
      title,
      level: "none",
      createdAt,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const seat = yield* agents.open(id);
        yield* seat.ask(prompt);
      })
    );
    return id;
  });

describe(Search, () => {
  it("finds a conversation's prompts and answers", async () => {
    const { layer } = setup([answer("The echidna is a monotreme.")]);

    const { byAnswer, byPrompt, id } = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* Search;
        const created = yield* converse("Monotremes", "which mammals lay eggs");
        yield* search.indexConversation(created);
        return {
          id: created,
          byAnswer: yield* search.query("echidna"),
          byPrompt: yield* search.query("mammals"),
        };
      }).pipe(Effect.provide(layer))
    );

    expect(byAnswer.map((hit) => hit.id)).toStrictEqual([Number(id)]);
    const [hit] = byAnswer;
    expect(hit).toMatchObject({ title: "Monotremes", archived: false });
    expect(
      hit?.matches[0]?.snippet.some(
        (segment) => segment.match && segment.text === "echidna"
      )
    ).toBeTruthy();
    expect(byPrompt[0]?.matches[0]).toMatchObject({ role: "user" });
  });

  it("finds a conversation by its title, with no entry on the hit", async () => {
    const { layer } = setup([answer("done")]);

    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* Search;
        const id = yield* converse("Monotremes", "hi");
        yield* search.indexConversation(id);
        return yield* search.query("Monotremes");
      }).pipe(Effect.provide(layer))
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.matches[0]).toMatchObject({ role: "title" });
    expect(found[0]?.matches[0]?.entry).toBeUndefined();
  });

  it("leaves tool calls and results out of the index", async () => {
    const { layer } = setup([
      callTool("bash", { command: "echo unindextoken" }),
      answer("done without tools"),
    ]);

    const { id, promptHit, toolHit } = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* Search;
        const created = yield* converse("tools", "run something");
        yield* search.indexConversation(created);
        return {
          id: created,
          promptHit: yield* search.query("something"),
          toolHit: yield* search.query("unindextoken"),
        };
      }).pipe(Effect.provide(layer))
    );

    // The prompt is found; the tool call's arguments and its result are not.
    expect(promptHit.map((hit) => hit.id)).toStrictEqual([Number(id)]);
    expect(toolHit).toStrictEqual([]);
  });

  it("still finds an archived conversation, flagged", async () => {
    const { layer } = setup([answer("done")]);

    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const search = yield* Search;
        const id = yield* converse("mellohi", "say mellohi");
        yield* search.indexConversation(id);
        yield* agents.archive(id, Date.now());
        return yield* search.query("mellohi");
      }).pipe(Effect.provide(layer))
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ title: "mellohi", archived: true });
  });

  it("indexes a second time without duplicating results", async () => {
    const { layer } = setup([answer("done")]);

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* Search;
        const id = yield* converse("idempotent", "a persistent token");
        yield* search.indexConversation(id);
        const before = yield* search.query("persistent");
        yield* search.indexConversation(id);
        return { first: before, second: yield* search.query("persistent") };
      }).pipe(Effect.provide(layer))
    );

    expect(second).toStrictEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("lists the most recent conversations for an unmatchable query", async () => {
    const { layer } = setup([answer("a"), answer("b")]);

    const { hits, ids } = await Effect.runPromise(
      Effect.gen(function* () {
        const search = yield* Search;
        const older = yield* converse("zebra file", "one", 1000);
        const newer = yield* converse("yak file", "two", 2000);
        return { hits: yield* search.query("!!!"), ids: [newer, older] };
      }).pipe(Effect.provide(layer))
    );

    // Zero-state: the newest conversations with no matches — nothing indexed needed.
    expect(hits.map((hit) => hit.id)).toStrictEqual(ids.map(Number));
    expect(hits.every((hit) => hit.matches.length === 0)).toBeTruthy();
  });

  it("fails indexConversation for an unknown conversation", async () => {
    const { layer } = setup([]);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const search = yield* Search;
        return yield* search.indexConversation(999_999 as ConversationId);
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("resumes from the cursor stored in the index file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-search-"));
    try {
      const file = path.join(dir, "search.sqlite");
      const transcript = path.join(dir, "transcript.sqlite");
      // The transcript store is a real file so a second layer build reopens it.
      const layer = (responses: FauxResponseStep[]) =>
        Layer.unwrap(
          Effect.map(
            Effect.promise(() => openNodeSqliteStorage(transcript)),
            (storage) =>
              Search.layer({ database: file }).pipe(
                Layer.provideMerge(fauxAgents(responses, { storage }).layer)
              )
          )
        );

      const { hits: first, created } = await Effect.runPromise(
        Effect.gen(function* () {
          const search = yield* Search;
          const id = yield* converse("echidnas", "which mammals lay eggs");
          yield* search.indexConversation(id);
          return { created: id, hits: yield* search.query("echidna") };
        }).pipe(Effect.provide(layer([answer("The echidna is a monotreme.")])))
      );
      expect(first.length).toBeGreaterThan(0);

      // A new Search over the same file resumes at the cursor: indexing again adds nothing.
      const second = await Effect.runPromise(
        Effect.gen(function* () {
          const search = yield* Search;
          yield* search.indexConversation(created);
          return yield* search.query("echidna");
        }).pipe(Effect.provide(layer([])))
      );

      expect(second).toStrictEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

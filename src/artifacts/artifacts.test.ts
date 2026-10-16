import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { ARTIFACT_MAX_EDITS, Artifacts } from "./artifacts.ts";

/** Run `program` against a temporary Artifacts. */
const withArtifacts = <A, E>(
  program: (artifacts: (typeof Artifacts)["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        return yield* program(artifacts);
      })
    ).pipe(Effect.provide(Artifacts.temporary()))
  );

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "ok";

describe("artifacts", () => {
  it("creates a page and updates it version by version", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const created = yield* artifacts.create(1, {
          title: "Report",
          html: "<h1>One</h1>",
          callId: "c1",
        });
        const edited = yield* artifacts.update(1, created.id, {
          callId: "c2",
          edits: [{ find: "One", replace: "Two" }],
        });
        const replaced = yield* artifacts.update(1, created.id, {
          callId: "c3",
          html: "<p>New page</p>",
          title: "Renamed",
        });
        return {
          created,
          edited,
          replaced,
          view: yield* artifacts.view(1, created.id),
          latest: yield* artifacts.html(1, created.id),
          first: yield* artifacts.html(1, created.id, 1),
          missing: yield* Effect.exit(artifacts.html(1, created.id, 9)),
          list: yield* artifacts.list(1),
        };
      })
    );
    expect(result.created.id).toMatch(/^art_[0-9a-f]{32}$/u);
    expect(result).toMatchObject({
      created: { version: 1, title: "Report" },
      edited: { id: result.created.id, version: 2 },
      replaced: { id: result.created.id, version: 3, title: "Renamed" },
      view: {
        id: result.created.id,
        title: "Renamed",
        versions: [
          { version: 1, title: "Report" },
          { version: 2, title: "Report" },
          { version: 3, title: "Renamed" },
        ],
      },
      latest: { version: 3, html: "<p>New page</p>" },
      first: { version: 1, html: "<h1>One</h1>" },
      list: [{ id: result.created.id }],
    });
    expect(Exit.isFailure(result.missing)).toBeTruthy();
  });

  it("applies edits only when every find occurs exactly once", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const created = yield* artifacts.create(1, {
          title: "Page",
          html: "<p>a b a</p><p>c</p>",
          callId: "c1",
        });
        const ambiguous = yield* Effect.exit(
          artifacts.update(1, created.id, {
            callId: "c2",
            edits: [{ find: "a", replace: "x" }],
          })
        );
        const missing = yield* Effect.exit(
          artifacts.update(1, created.id, {
            callId: "c3",
            edits: [{ find: "z", replace: "x" }],
          })
        );
        // One bad pair keeps the whole call out: version 1 is still the only page.
        const mixed = yield* Effect.exit(
          artifacts.update(1, created.id, {
            callId: "c4",
            edits: [
              { find: "c", replace: "C" },
              { find: "z", replace: "x" },
            ],
          })
        );
        const tooMany = yield* Effect.exit(
          artifacts.update(1, created.id, {
            callId: "c5",
            edits: Array.from({ length: ARTIFACT_MAX_EDITS + 1 }, (_, i) => ({
              find: `${i}`,
              replace: "x",
            })),
          })
        );
        return {
          id: created.id,
          ambiguous,
          missing,
          mixed,
          tooMany,
          view: yield* artifacts.view(1, created.id),
          latest: yield* artifacts.html(1, created.id),
        };
      })
    );
    expect(
      [result.ambiguous, result.missing, result.mixed, result.tooMany].map(
        failure
      )
    ).toStrictEqual([
      expect.stringContaining("occurs 2 times"),
      expect.stringContaining("is not in the page"),
      expect.stringContaining("is not in the page"),
      expect.stringContaining("at most"),
    ]);
    expect(result.view.versions).toHaveLength(1);
    expect(result.latest.html).toBe("<p>a b a</p><p>c</p>");
  });

  it("refuses a page over 300 KB, on create and on update", async () => {
    const big = `<p>${"x".repeat(300 * 1024)}</p>`;
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const created = yield* artifacts.create(1, {
          title: "Small",
          html: "<p>ok</p>",
          callId: "c1",
        });
        return {
          create: yield* Effect.exit(
            artifacts.create(1, { title: "Big", html: big, callId: "c2" })
          ),
          update: yield* Effect.exit(
            artifacts.update(1, created.id, { callId: "c3", html: big })
          ),
          view: yield* artifacts.view(1, created.id),
        };
      })
    );
    expect(failure(result.create)).toContain("300 KB");
    expect(failure(result.update)).toContain("300 KB");
    expect(result.view.versions).toHaveLength(1);
  });

  it("scopes every lookup to its conversation, and removes within it", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const theirs = yield* artifacts.create(1, {
          title: "Theirs",
          html: "<p>1</p>",
          callId: "c1",
        });
        const mine = yield* artifacts.create(2, {
          title: "Mine",
          html: "<p>2</p>",
          callId: "c2",
        });
        yield* artifacts.remove(2, mine.id);
        return {
          exits: [
            yield* Effect.exit(artifacts.view(2, theirs.id)),
            yield* Effect.exit(artifacts.html(2, theirs.id)),
            yield* Effect.exit(
              artifacts.update(2, theirs.id, { callId: "c3", html: "<p>x</p>" })
            ),
            yield* Effect.exit(artifacts.remove(2, theirs.id)),
            yield* Effect.exit(artifacts.view(2, mine.id)),
            // Conversation 1's artifact is still there.
            yield* Effect.exit(artifacts.view(1, theirs.id)),
          ],
          remaining: (yield* artifacts.list(2)).length,
        };
      })
    );
    expect(result.exits.map(failure)).toStrictEqual([
      expect.stringContaining("ArtifactNotFound"),
      expect.stringContaining("ArtifactNotFound"),
      expect.stringContaining("ArtifactNotFound"),
      expect.stringContaining("ArtifactNotFound"),
      expect.stringContaining("ArtifactNotFound"),
      "ok",
    ]);
    expect(result.remaining).toBe(0);
  });

  it("lets a replayed call find the version it already wrote", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const first = yield* artifacts.create(1, {
          title: "Page",
          html: "<p>one</p>",
          callId: "call-1",
        });
        const replayed = yield* artifacts.create(1, {
          title: "Page",
          html: "<p>one</p>",
          callId: "call-1",
        });
        const edited = yield* artifacts.update(1, first.id, {
          callId: "call-2",
          edits: [{ find: "one", replace: "two" }],
        });
        const again = yield* artifacts.update(1, first.id, {
          callId: "call-2",
          edits: [{ find: "one", replace: "two" }],
        });
        return {
          first,
          replayed,
          edited,
          again,
          view: yield* artifacts.view(1, first.id),
          count: (yield* artifacts.list(1)).length,
        };
      })
    );
    expect(result).toMatchObject({
      replayed: result.first,
      again: result.edited,
      count: 1,
      view: { versions: [{ version: 1 }, { version: 2 }] },
    });
  });
});

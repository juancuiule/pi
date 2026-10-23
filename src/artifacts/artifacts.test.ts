import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Exit, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { ConversationEvent } from "../conversation-events.ts";
import {
  ask,
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
  openSeat,
} from "../testing/faux.ts";
import { ARTIFACT_MAX_EDITS, Artifacts } from "./artifacts.ts";

/** Run `program` against a temporary Artifacts; `trusted` presets its image domains. */
const withArtifacts = <A, E>(
  program: (artifacts: (typeof Artifacts)["Service"]) => Effect.Effect<A, E>,
  trusted?: readonly string[]
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        return yield* program(artifacts);
      })
    ).pipe(Effect.provide(Artifacts.temporary(trusted)))
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

  it("refuses a page that loads anything but images from trusted domains", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const remoteImage = yield* Effect.exit(
          artifacts.create(1, {
            title: "Untrusted",
            html: '<img src="https://cdn.evil.com/a.png">',
            callId: "c1",
          })
        );
        const remoteScript = yield* Effect.exit(
          artifacts.create(1, {
            title: "Script",
            html: '<script src="https://cdn.evil.com/x.js"></script>',
            callId: "c2",
          })
        );
        const clean = yield* artifacts.create(1, {
          title: "Clean",
          html: '<img src="/api/attachments/att_x/thumbnail?conversation=1"><script src="/api/artifact-libs/chart.umd.js"></script>',
          callId: "c3",
        });
        const editedRemote = yield* Effect.exit(
          artifacts.update(1, clean.id, {
            callId: "c4",
            edits: [
              {
                find: '<img src="/api/attachments/att_x/thumbnail?conversation=1">',
                replace: '<img src="https://cdn.evil.com/a.png">',
              },
            ],
          })
        );
        return {
          remoteImage,
          remoteScript,
          editedRemote,
          view: yield* artifacts.view(1, clean.id),
        };
      })
    );
    expect(failure(result.remoteImage)).toContain("cdn.evil.com");
    expect(failure(result.remoteImage)).toContain("Trusted domains");
    expect(failure(result.remoteScript)).toContain("external scripts");
    expect(failure(result.editedRemote)).toContain("cdn.evil.com");
    // The refused update added no version.
    expect(result.view.versions).toHaveLength(1);
  });

  it("lets a page's images come from a trusted domain", async () => {
    const result = await withArtifacts(
      (artifacts) =>
        Effect.gen(function* () {
          const created = yield* artifacts.create(1, {
            title: "Images",
            html: '<img src="https://a.cdn.example.com/1.png"><img src="https://b.cdn.example.com/2.png">',
            callId: "c1",
          });
          return yield* artifacts.html(1, created.id);
        }),
      ["*.cdn.example.com"]
    );
    expect(result.version).toBe(1);
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

  it("lists every conversation's artifacts, most recently updated first", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const one = yield* artifacts.create(1, {
          title: "One",
          html: "<p>1</p>",
          callId: "c1",
        });
        yield* Effect.sleep("5 millis");
        const two = yield* artifacts.create(2, {
          title: "Two",
          html: "<p>2</p>",
          callId: "c2",
        });
        yield* Effect.sleep("5 millis");
        // One's update makes it the most recently touched, ahead of the newer two.
        yield* artifacts.update(1, one.id, {
          callId: "c3",
          html: "<p>1.</p>",
        });
        return {
          ids: [one.id, two.id],
          all: yield* artifacts.listAll(),
          scoped: yield* artifacts.list(2),
        };
      })
    );
    expect(
      result.all.map((view) => [view.id, view.conversationId])
    ).toStrictEqual([
      [result.ids[0], 1],
      [result.ids[1], 2],
    ]);
    expect(result.scoped.map((view) => view.id)).toStrictEqual([result.ids[1]]);
  });

  it("lists a conversation's artifacts most recently updated first", async () => {
    const result = await withArtifacts((artifacts) =>
      Effect.gen(function* () {
        const older = yield* artifacts.create(1, {
          title: "Older",
          html: "<p>1</p>",
          callId: "c1",
        });
        yield* Effect.sleep("5 millis");
        yield* artifacts.create(1, {
          title: "Newer",
          html: "<p>2</p>",
          callId: "c2",
        });
        const created = (yield* artifacts.list(1)).map((view) => view.title);
        yield* Effect.sleep("5 millis");
        yield* artifacts.update(1, older.id, {
          callId: "c3",
          html: "<p>1.</p>",
        });
        const updated = (yield* artifacts.list(1)).map((view) => view.title);
        return { created, updated };
      })
    );
    expect(result.created).toStrictEqual(["Newer", "Older"]);
    expect(result.updated).toStrictEqual(["Older", "Newer"]);
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

/** A parent's turn that revises the page whose id its subagent reported back. */
const reviseReported: FauxResponseStep = (request) => {
  const reported = request.messages
    .findLast((message) => message.role === "toolResult")
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
    .match(/art_[0-9a-f]{32}/u)?.[0];
  return callTool("artifact_update", {
    id: reported ?? "art_none",
    edits: [{ find: "Child", replace: "Parent" }],
  });
};

/** The settled tool results among a conversation's events. */
const toolResults = (events: readonly ConversationEvent[]) =>
  events.flatMap((event) =>
    event.type === "tool_execution_end" && event.entry !== undefined
      ? (event.entry.model ?? []).flatMap((m) =>
          m.role === "toolResult" ? [m] : []
        )
      : []
  );

const waitUntil = (check: Effect.Effect<boolean, unknown>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

describe("the artifact tools", () => {
  it("writes and revises a page, and carries its reference in the result's details", async () => {
    const { layer, faux } = fauxAgents([]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const artifacts = yield* Artifacts;
          const seat = yield* openSeat();
          const seen = yield* Ref.make<ConversationEvent[]>([]);
          const events = yield* agents.events(seat.id);
          const scope = yield* Scope.Scope;
          yield* Stream.runForEach(events, (event) =>
            Ref.update(seen, (all) => [...all, event])
          ).pipe(Effect.forkIn(scope));
          faux.setResponses([
            callTool("artifact_create", {
              title: "Report",
              html: "<h1>Hi</h1>",
            }),
            echoToolResult,
          ]);
          const created = yield* seat.ask("Make a page.");
          const [listed] = yield* artifacts.list(Number(seat.id));
          faux.setResponses([
            callTool("artifact_update", {
              id: listed?.id ?? "",
              edits: [{ find: "Hi", replace: "There" }],
              title: "Renamed",
            }),
            echoToolResult,
          ]);
          const updated = yield* seat.ask("Change it.");
          yield* waitUntil(
            Ref.get(seen).pipe(
              Effect.map((all) => toolResults(all).length === 2)
            )
          );
          return {
            created,
            updated,
            id: listed?.id ?? "",
            details: toolResults(yield* Ref.get(seen)).map(
              (message) => message.details
            ),
            view:
              listed === undefined
                ? undefined
                : yield* artifacts.view(Number(seat.id), listed.id),
            latest:
              listed === undefined
                ? undefined
                : yield* artifacts.html(Number(seat.id), listed.id),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.created).toContain("the person already sees the page");
    expect(result.updated).toContain("do not paste the HTML");
    expect(result.details).toStrictEqual([
      { id: result.id, version: 1, title: "Report" },
      { id: result.id, version: 2, title: "Renamed" },
    ]);
    expect(result.view?.versions).toHaveLength(2);
    expect(result.latest?.html).toBe("<h1>There</h1>");
  });

  it("offers the tools and tells the agent what a page is and which libraries it serves", async () => {
    const { layer } = fauxAgents([offered], {
      trustedDomains: ["cdn.example.com"],
    });
    const answer = await Effect.runPromise(
      ask("What can you do?").pipe(Effect.provide(layer))
    );
    const { tools, system } = offeredIn(answer);
    expect(tools).toStrictEqual(
      expect.arrayContaining(["artifact_create", "artifact_update"])
    );
    expect(
      [
        "/api/artifact-libs/chart.umd.js",
        "/api/artifact-libs/pele.global.js",
      ].map((lib) => system.includes(lib))
    ).toStrictEqual([true, true]);
    expect(system).toContain("300 KB");
    expect(system).toContain("cdn.example.com");
    expect(system).toContain("/api/attachments/<id>/thumbnail?conversation=");
  });

  it("reads a refused page as a normal error naming the untrusted host", async () => {
    const { layer, faux } = fauxAgents([]);
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          faux.setResponses([
            callTool("artifact_create", {
              title: "Results",
              html: '<img src="https://cdn.elgatoylacaja.com/x.jpg">',
            }),
            echoToolResult,
          ]);
          return yield* seat.ask("Show the results.");
        })
      ).pipe(Effect.provide(layer))
    );
    expect(answer).toContain("error: ");
    expect(answer).toContain("cdn.elgatoylacaja.com");
    expect(answer).toContain("Trusted domains");
  });

  it("reads a missing artifact or a refused change as a normal error", async () => {
    const { layer, faux } = fauxAgents([]);
    const answers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          faux.setResponses([
            callTool("artifact_update", {
              id: "art_missing",
              html: "<p>x</p>",
            }),
            echoToolResult,
          ]);
          const missing = yield* seat.ask("Change it.");
          faux.setResponses([
            callTool("artifact_create", {
              title: "Big",
              html: `<p>${"x".repeat(300 * 1024)}</p>`,
            }),
            echoToolResult,
          ]);
          const big = yield* seat.ask("Bigger.");
          return [missing, big];
        })
      ).pipe(Effect.provide(layer))
    );
    expect(answers[0]).toContain("error: ");
    expect(answers[0]).toContain("No artifact art_missing");
    expect(answers[1]).toContain("300 KB");
  });

  it("keeps a subagent's page in its root conversation, where the parent can revise it", async () => {
    const { layer } = fauxAgents([
      fauxAssistantMessage(
        [fauxToolCall("task", { prompt: "Make a page." }, { id: "call-task" })],
        { stopReason: "toolUse" }
      ),
      // The subagent's turns: it creates the page and answers with the result, which names the id.
      callTool("artifact_create", { title: "Report", html: "<h1>Child</h1>" }),
      echoToolResult,
      reviseReported,
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifacts = yield* Artifacts;
          const seat = yield* openSeat();
          const answer = yield* seat.ask("Have a subagent make a page.");
          const [listed] = yield* artifacts.list(Number(seat.id));
          return {
            answer,
            listed,
            latest:
              listed === undefined
                ? undefined
                : yield* artifacts.html(Number(seat.id), listed.id),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.answer).toContain("to version 2");
    expect(result.listed?.versions.map((v) => v.version)).toStrictEqual([1, 2]);
    expect(result.latest?.html).toBe("<h1>Parent</h1>");
  });
});

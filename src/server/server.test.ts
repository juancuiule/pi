import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { AgentError } from "../agents/agents.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Attachments } from "../attachments/attachments.ts";
import { Capacity } from "../capacity.ts";
import { Skills } from "../skills/skills.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { fakeMcpServer } from "../testing/mcp.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { echoModel } from "./faux.ts";
import { ApiLayer } from "./handlers.ts";

const serverWith = (
  agents: Layer.Layer<Agents | Capacity | Attachments | Artifacts, AgentError>
) =>
  HttpRouter.serve(ApiLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Conversations.layer({
        idleTimeoutMs: 60_000,
        sweepEveryMs: 60_000,
      })
    ),
    Layer.provide(agents),
    Layer.provideMerge(NodeHttpServer.layerTest)
  );

const server = (responses: FauxResponseStep[], shells = 3) =>
  serverWith(fauxAgents(responses, { limits: { shells } }).layer);

/** A multipart upload of one text file, staged or to `conversation`. */
const form = (name: string, body: string, conversation?: number) => {
  const data = new FormData();
  data.append("file", new Blob([body], { type: "text/plain" }), name);
  if (conversation !== undefined) {
    data.append("conversation", String(conversation));
  }
  return data;
};

describe("HTTP API", () => {
  it("lists skills and MCP servers", async () => {
    const echo = fakeMcpServer("test", [
      { name: "echo", call: () => ({ content: [] }) },
    ]);
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        return yield* client.info.capabilities();
      }).pipe(
        Effect.provide(
          serverWith(
            fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
              skills: Skills.directory("skills"),
              mcp: [echo],
            }).layer
          )
        )
      )
    );
    expect(capabilities.skills.map((s) => s.name)).toContain("unit-conversion");
    expect(capabilities.mcp).toStrictEqual([
      {
        name: "test",
        url: "memory://test",
        status: "connected",
        tools: [{ name: "echo", description: "" }],
      },
    ]);
  });

  it("lists every extension, and what one conversation runs with", async () => {
    const { extensions, agent } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const capabilities = yield* client.info.capabilities();
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi" },
        });
        return {
          extensions: capabilities.extensions,
          agent: yield* client.conversations.agent({
            params: { id: created.id },
          }),
        };
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("ok")])])))
    );

    const byName = new Map(extensions.map((each) => [each.name, each]));
    expect(
      [
        "calculator",
        "coding-tools",
        "desktop",
        "workspace",
        "artifacts",
        "tracing",
      ].map((name) => byName.get(name)?.levels)
    ).toStrictEqual([
      ["none", "shell", "desktop"],
      ["shell", "desktop"],
      ["desktop"],
      ["none", "shell", "desktop"],
      ["none", "shell", "desktop"],
      ["none", "shell", "desktop"],
    ]);
    // Which tools wait for a decision under `ask`.
    expect(
      byName
        .get("coding-tools")
        ?.tools.map((tool) => [tool.name, tool.approval])
    ).toStrictEqual([
      ["read", false],
      ["write", true],
      ["edit", true],
      ["bash", true],
    ]);
    expect([
      agent.extensions.flatMap((each) =>
        each.enabled
          ? each.tools.filter((t) => t.enabled).map((t) => t.name)
          : []
      ),
      agent.extensions
        .filter((each) => !each.available)
        .map((each) => each.name),
      agent.sections,
    ]).toStrictEqual([
      [
        "calculate",
        "upgrade_workspace",
        "read_attachment",
        "search_attachment",
        "artifact_create",
        "artifact_update",
        "ask_user",
      ],
      ["coding-tools", "desktop"],
      ["workspace", "attachments", "artifacts"],
    ]);
  });

  it("expands /skill: on create and refuses an unknown skill on send", async () => {
    const agents = fauxAgents(
      [
        fauxAssistantMessage([fauxText("one")]),
        fauxAssistantMessage([fauxText("two")]),
      ],
      { skills: Skills.directory("skills") }
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: {
            sandbox: "none",
            prompt: "/skill:unit-conversion 3 mi to km",
          },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const events = yield* stream.pipe(
          Stream.takeUntil(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "type" in event &&
              (event.type === "run_end" ||
                (event.type === "snapshot" &&
                  JSON.stringify(event).includes('"one"')))
          ),
          Stream.runCollect
        );
        const unknown = yield* Effect.flip(
          client.conversations.send({
            params: { id: created.id },
            payload: { prompt: "/skill:nope hi" },
          })
        );
        return { created, unknown, events: JSON.stringify([...events]) };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result.created.title).toBe("/skill:unit-conversion 3 mi to km");
    expect(result.events).toContain('<skill name=\\"unit-conversion\\">');
    expect(result.events).toContain("3 mi to km");
    expect(result.unknown).toMatchObject({
      _tag: "SkillNotFound",
      name: "nope",
    });
    // The rejected send queued nothing: only the first prompt reached the model.
    expect(agents.faux.state.callCount).toBe(1);
  });

  it("refuses requests from a non-loopback origin", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const post = (origin: string) =>
          client
            .execute(
              HttpClientRequest.post("/api/conversations").pipe(
                HttpClientRequest.setHeader("origin", origin),
                HttpClientRequest.bodyJsonUnsafe({
                  sandbox: "none",
                  prompt: "hi",
                })
              )
            )
            .pipe(Effect.map((response) => response.status));
        return [
          yield* post("https://evil.example"),
          yield* post("http://localhost:3001"),
        ];
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("ok")])])))
    );

    expect(statuses).toStrictEqual([403, 201]);
  });

  it("creates a conversation and streams its events over SSE", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "Capital of France?" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        return [
          ...(yield* stream.pipe(
            // The run may finish before the stream attaches, then the snapshot already holds the answer.
            Stream.takeUntil(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                (event.type === "run_end" ||
                  (event.type === "snapshot" &&
                    JSON.stringify(event).includes("Paris.")))
            ),
            Stream.runCollect
          )),
        ];
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("Paris.")])]))
      )
    );

    expect(events[0]).toMatchObject({ type: "snapshot" });
    expect(JSON.stringify(events)).toContain("Paris.");
  });

  it("lists, sends to, pauses, resumes and archives conversations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hello" },
        });
        const listed = yield* client.conversations.list();
        expect(listed.map((c) => [c.id, c.title])).toStrictEqual([
          [created.id, "hello"],
        ]);
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "again" },
        });
        // Stop returns once nothing runs, so the Pause is immediate.
        yield* client.conversations.stop({ params: { id: created.id } });
        yield* client.conversations.pause({ params: { id: created.id } });
        const statusOf = client.conversations
          .list()
          .pipe(Effect.map((all) => all.map((c) => [c.id, c.status])));
        expect(yield* statusOf).toStrictEqual([[created.id, "paused"]]);
        const capacity = yield* client.info.capacity();
        expect(
          capacity.every((each) => each.holders.length === 0)
        ).toBeTruthy();
        const resumed = yield* client.conversations.resume({
          params: { id: created.id },
        });
        expect([resumed.status, resumed.sandboxId === undefined]).toStrictEqual(
          ["idle", false]
        );
        yield* client.conversations.archive({ params: { id: created.id } });
        const archived = yield* statusOf;
        yield* client.conversations.unarchive({ params: { id: created.id } });
        expect([archived, yield* statusOf]).toStrictEqual([
          [[created.id, "archived"]],
          [[created.id, "paused"]],
        ]);
      }).pipe(
        Effect.provide(
          server([
            fauxAssistantMessage([fauxText("one")]),
            fauxAssistantMessage([fauxText("two")]),
          ])
        )
      )
    );
  });

  // Issue #16: the send's answer names its submission so the console's pending message can resolve; a retried
  // requestId is the same submission again, not a second message.
  it("answers sends with the submission a requestId deduplicates", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi", requestId: "create-1" },
        });
        const sent = yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "again", requestId: "send-1" },
        });
        const retry = yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "again", requestId: "send-1" },
        });
        return { created, sent, retry };
      }).pipe(
        Effect.provide(
          server([
            fauxAssistantMessage([fauxText("one")]),
            fauxAssistantMessage([fauxText("two")]),
          ])
        )
      )
    );
    expect(result.created.submission.id).toBeTypeOf("number");
    expect(result.sent.id).toBeTypeOf("number");
    expect(result.retry.id).toBe(result.sent.id);
  });

  // Issue #16: a retried requestId must reach the dedup check — claiming its files first would refuse the
  // already-sent ones, or commit new files no message references.
  it("deduplicates a retried send with files instead of refusing or re-claiming them", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi" },
        });
        const file = yield* client.attachments.upload({
          payload: form("a.txt", "first", created.id),
        });
        const other = yield* client.attachments.upload({
          payload: form("b.txt", "second", created.id),
        });
        const sent = yield* client.conversations.send({
          params: { id: created.id },
          payload: {
            prompt: "with a file",
            attachments: [file.id],
            requestId: "send-files",
          },
        });
        // The retry names the same files, now already claimed and sent: only a dedup before claiming answers.
        const sameFiles = yield* client.conversations.send({
          params: { id: created.id },
          payload: {
            prompt: "with a file",
            attachments: [file.id],
            requestId: "send-files",
          },
        });
        // Same requestId, different files: deduped too, claiming nothing — `other` stays unsent for a real send.
        const differentFiles = yield* client.conversations.send({
          params: { id: created.id },
          payload: {
            prompt: "unrelated",
            attachments: [other.id],
            requestId: "send-files",
          },
        });
        const later = yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "for real this time", attachments: [other.id] },
        });
        return { sent, sameFiles, differentFiles, later };
      }).pipe(
        Effect.provide(
          server([
            fauxAssistantMessage([fauxText("one")]),
            fauxAssistantMessage([fauxText("two")]),
            fauxAssistantMessage([fauxText("three")]),
            fauxAssistantMessage([fauxText("four")]),
          ])
        )
      )
    );
    expect(result.sameFiles.id).toBe(result.sent.id);
    expect(result.differentFiles.id).toBe(result.sent.id);
    expect(result.later.id).toBeTypeOf("number");
  });

  it("rejects a requestId beyond its bound", async () => {
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi" },
        });
        return yield* Effect.exit(
          client.conversations.send({
            params: { id: created.id },
            payload: { prompt: "hi", requestId: "x".repeat(200) },
          })
        );
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("one")])])))
    );
    expect(Exit.isFailure(exits)).toBeTruthy();
  });

  it("reports the model", async () => {
    const info = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        return yield* client.info.get();
      }).pipe(Effect.provide(server([])))
    );

    expect(info.model).toBe("faux/faux-1");
  });

  it("answers 404 for unknown conversations and 409 at a Capacity limit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const missing = yield* Effect.exit(
          client.conversations.pause({ params: { id: 424_242 } })
        );
        expect(Exit.isFailure(missing)).toBeTruthy();
        expect(JSON.stringify(missing)).toContain("ConversationNotFound");
        const missingEvents = yield* Effect.exit(
          client.conversations.events({ params: { id: 424_242 } })
        );
        expect(JSON.stringify(missingEvents)).toContain("ConversationNotFound");

        yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "1" },
        });
        const second = yield* Effect.exit(
          client.conversations.create({
            payload: { sandbox: "shell", prompt: "2" },
          })
        );
        expect(JSON.stringify(second)).toContain("CapacityExhausted");
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("a")])], 1))
      )
    );
  });

  it("the echo model answers every prompt", async () => {
    const { models, model } = echoModel();
    const sandboxes = localSandboxes();
    const agents = Agents.layer({ models, model }).pipe(
      Layer.provide(sandboxes.layer),
      Layer.provide(Skills.none),
      Layer.provideMerge(Attachments.temporary()),
      Layer.provideMerge(Artifacts.temporary()),
      Layer.provideMerge(Capacity.layer({ seats: 1, shells: 1, desktops: 1 }))
    );

    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "ping" },
        });
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "pong" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const seen: unknown[] = [];
        yield* stream.pipe(
          Stream.takeUntil((event) => {
            seen.push(event);
            return JSON.stringify(seen).includes("echo: pong");
          }),
          Stream.runDrain
        );
        return JSON.stringify(seen);
      }).pipe(Effect.provide(serverWith(agents)))
    );

    expect(text).toContain("echo: ping");
    expect(text).toContain("echo: pong");
  });

  it("uploads files, sends them with a message, and serves them only in their scope", async () => {
    const agents = fauxAgents([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const http = yield* HttpClient.HttpClient;
        const empty = yield* Effect.flip(
          client.conversations.create({
            payload: { sandbox: "none", prompt: "  " },
          })
        );
        const unsupported = yield* Effect.flip(
          client.attachments.upload({ payload: form("a.exe", "MZ") })
        );
        const staged = yield* client.attachments.upload({
          payload: form("brief.md", "# Brief\n\nKeep it short."),
        });
        // A message of only files; the conversation is named after them.
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", attachments: [staged.id] },
        });
        const again = yield* Effect.flip(
          client.conversations.create({
            payload: { sandbox: "none", attachments: [staged.id] },
          })
        );
        const later = yield* client.attachments.upload({
          payload: form("later.txt", "more", created.id),
        });
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "and this", attachments: [later.id] },
        });
        const download = (id: string, conversation?: number) =>
          http
            .get(
              `/api/attachments/${id}/original${conversation === undefined ? "" : `?conversation=${conversation}`}`
            )
            .pipe(
              Effect.flatMap((response) =>
                response.text.pipe(
                  Effect.map((body) => ({
                    status: response.status,
                    body,
                    disposition: response.headers["content-disposition"],
                    nosniff: response.headers["x-content-type-options"],
                  }))
                )
              )
            );
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const events = yield* stream.pipe(
          Stream.takeUntil((event) => JSON.stringify(event).includes('"two"')),
          Stream.runCollect
        );
        return {
          empty,
          unsupported,
          staged,
          created,
          again,
          owned: yield* download(staged.id, created.id),
          viewed: yield* client.attachments.view({
            params: { id: staged.id },
            query: { conversation: created.id },
          }),
          viewedElsewhere: yield* Effect.flip(
            client.attachments.view({
              params: { id: staged.id },
              query: { conversation: created.id + 1 },
            })
          ),
          unscoped: yield* download(staged.id),
          elsewhere: yield* download(staged.id, created.id + 1),
          events: JSON.stringify([...events]),
        };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result).toMatchObject({
      empty: { _tag: "EmptyMessage" },
      unsupported: { _tag: "AttachmentRefused", reason: "unsupported" },
      staged: { name: "brief.md", status: "ready" },
      // A message of only files; the conversation is named after them.
      created: { title: "brief.md" },
      again: { _tag: "AttachmentNotFound" },
      owned: {
        status: 200,
        body: "# Brief\n\nKeep it short.",
        nosniff: "nosniff",
      },
      viewed: {
        info: { name: "brief.md", kind: "text" },
        prepared: { kind: "text", pages: ["# Brief\n\nKeep it short."] },
      },
      viewedElsewhere: { _tag: "AttachmentNotFound" },
      unscoped: { status: 404 },
      elsewhere: { status: 404 },
    });
    expect(result.owned.disposition).toContain("attachment;");
    expect(result.events).toContain("Keep it short.");
    expect(result.events).toContain("and this");
  });

  it("serves a conversation's pages sandboxed, and the libraries they may load", async () => {
    const html =
      '<pre class="mermaid">graph TD; A-->B</pre><script src="/api/artifact-libs/mermaid.min.js"></script>';
    const agents = fauxAgents([
      callTool("artifact_create", { title: "Diagram", html }),
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const http = yield* HttpClient.HttpClient;
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "draw it" },
        });
        const list = () =>
          client.artifacts.list({ query: { conversation: created.id } });
        let views = yield* list();
        while (views.length === 0) {
          yield* Effect.sleep("10 millis");
          views = yield* list();
        }
        const [artifact] = views;
        if (artifact === undefined) {
          return yield* Effect.die(new Error("no artifact created"));
        }
        const render = yield* http.get(
          `/api/artifacts/${artifact.id}/render?conversation=${created.id}`
        );
        const lib = yield* http.get("/api/artifact-libs/mermaid.min.js");
        const missingLib = yield* http.get("/api/artifact-libs/evil.js");
        const source = yield* client.artifacts.source({
          params: { id: artifact.id },
          query: { conversation: created.id, v: 1 },
        });
        const view = yield* client.artifacts.view({
          params: { id: artifact.id },
          query: { conversation: created.id },
        });
        yield* client.artifacts.remove({
          params: { id: artifact.id },
          query: { conversation: created.id },
        });
        const removed = yield* Effect.flip(
          client.artifacts.view({
            params: { id: artifact.id },
            query: { conversation: created.id },
          })
        );
        return {
          render: {
            status: render.status,
            csp: render.headers["content-security-policy"],
            type: render.headers["content-type"],
            nosniff: render.headers["x-content-type-options"],
            body: yield* render.text,
          },
          lib: {
            status: lib.status,
            type: lib.headers["content-type"],
            nosniff: lib.headers["x-content-type-options"],
            body: yield* lib.text,
          },
          missingLib: missingLib.status,
          source,
          view,
          removed,
        };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result).toMatchObject({
      render: {
        status: 200,
        csp: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
        type: expect.stringContaining("text/html"),
        nosniff: "nosniff",
        body: expect.stringContaining("/api/artifact-libs/mermaid.min.js"),
      },
      lib: {
        status: 200,
        type: expect.stringContaining("javascript"),
        nosniff: "nosniff",
        body: expect.stringContaining("mermaid"),
      },
      missingLib: 404,
      source: { version: 1, html: expect.stringContaining("graph TD") },
      view: { id: result.view.id, title: "Diagram" },
      removed: { _tag: "ArtifactNotFound" },
    });
    expect(result.lib.body.length).toBeGreaterThan(100_000);
    expect(result.view.versions).toHaveLength(1);
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { AgentError } from "../agents/agents.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import { Attachments } from "../attachments/attachments.ts";
import { Capacity } from "../capacity.ts";
import { Skills, SkillSource } from "../skills/skills.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { fakeMcpServer } from "../testing/mcp.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { echoModel } from "./faux.ts";
import { apiLayer } from "./handlers.ts";

const serverWith = (
  agents: Layer.Layer<
    Agents | Capacity | Attachments | Artifacts | TrustedDomains | Workspaces,
    AgentError
  >,
  skillSource: Layer.Layer<SkillSource> = SkillSource.memory({})
) =>
  HttpRouter.serve(apiLayer({ apiUrl: "http://127.0.0.1" }), {
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
    Layer.provide(skillSource),
    Layer.provideMerge(NodeHttpServer.layerTest)
  );

const server = (responses: FauxResponseStep[], shells = 3) =>
  serverWith(fauxAgents(responses, { limits: { shells } }).layer);

/** A model turn that calls artifact_create; call ids differ per page: `call_id` is unique across conversations. */
const page = (callId: string, title: string, html: string) =>
  fauxAssistantMessage(
    [fauxToolCall("artifact_create", { title, html }, { id: callId })],
    { stopReason: "toolUse" }
  );

const waitUntil = (check: Effect.Effect<boolean, unknown>) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep("10 millis");
    }
  });

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
    const skills = Skills.layer.pipe(
      Layer.provide(
        SkillSource.memory({
          "convert/SKILL.md":
            "---\nname: convert\ndescription: Convert units.\n---\n\n# Convert\n\nDo the thing.\n",
          "convert/references/factors.md": "mile → km: 1.609344",
          "broken/SKILL.md": "---\nname: broken\n---\nNo description.",
        })
      )
    );
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        return yield* client.info.capabilities();
      }).pipe(
        Effect.provide(
          serverWith(
            fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
              skills,
              mcp: [echo],
            }).layer
          )
        )
      )
    );
    expect(capabilities.skills).toStrictEqual([
      {
        name: "convert",
        description: "Convert units.",
        modelInvocable: true,
        files: ["SKILL.md", "references/factors.md"],
        body: "\n# Convert\n\nDo the thing.\n",
      },
    ]);
    expect(capabilities.skillProblems).toStrictEqual([
      "broken: description: is required",
    ]);
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
        "skill",
        "skill_save",
        "skill_delete",
      ],
      ["coding-tools", "desktop"],
      ["workspace", "attachments", "artifacts", "skills"],
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

  it("creates and updates org skills through PUT /api/skills/:name", async () => {
    const files: Record<string, string> = {
      "builtin/convert/SKILL.md":
        "---\nname: convert\ndescription: Builtin convert.\n---\n\nBuiltin.\n",
    };
    const agents = fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
      skills: Skills.layer.pipe(Layer.provide(SkillSource.memory(files))),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const saved = yield* client.skills.save({
          params: { name: "uploaded" },
          payload: {
            files: {
              "SKILL.md":
                "---\nname: uploaded\ndescription: Uploaded skill.\n---\n\nDo it.\n",
              "refs/guide.md": "reference",
            },
          },
        });
        // The org copy shadows the builtin folder of the same name.
        const shadowed = yield* client.skills.save({
          params: { name: "convert" },
          payload: {
            files: {
              "SKILL.md":
                "---\nname: convert\ndescription: Org convert.\n---\n\nOrg.\n",
            },
          },
        });
        const capabilities = yield* client.info.capabilities();
        const listed = capabilities.skills.find((s) => s.name === "convert");
        const noFile = yield* Effect.exit(
          client.skills.save({
            params: { name: "no-skill" },
            payload: { files: { "notes.md": "x" } },
          })
        );
        const badFrontmatter = yield* Effect.exit(
          client.skills.save({
            params: { name: "bad" },
            payload: {
              files: { "SKILL.md": "---\nname: bad\n---\nNo description." },
            },
          })
        );
        const mismatched = yield* Effect.exit(
          client.skills.save({
            params: { name: "renamed" },
            payload: {
              files: {
                "SKILL.md":
                  "---\nname: other\ndescription: Mismatch.\n---\n\nBody.\n",
              },
            },
          })
        );
        const traversal = yield* Effect.exit(
          client.skills.save({
            params: { name: "escape" },
            payload: {
              files: {
                "SKILL.md":
                  "---\nname: escape\ndescription: Escape.\n---\n\nBody.\n",
                "../outside.md": "no",
              },
            },
          })
        );
        return {
          saved,
          shadowed,
          listed,
          noFile,
          badFrontmatter,
          mismatched,
          traversal,
        };
      }).pipe(
        Effect.provide(serverWith(agents.layer, SkillSource.memory(files)))
      )
    );

    expect(result.saved).toStrictEqual({
      name: "uploaded",
      description: "Uploaded skill.",
      files: ["SKILL.md", "refs/guide.md"],
    });
    expect(result.shadowed.description).toBe("Org convert.");
    expect(files["org/uploaded/SKILL.md"]).toContain("name: uploaded");
    expect(files["builtin/convert/SKILL.md"]).toContain("Builtin convert.");
    expect(result.listed?.description).toBe("Org convert.");
    for (const rejected of [
      result.noFile,
      result.badFrontmatter,
      result.mismatched,
      result.traversal,
    ]) {
      expect(Exit.isFailure(rejected)).toBeTruthy();
      expect(JSON.stringify(rejected)).toContain("InvalidSkill");
    }
  });

  it("rejects a skill name that is not a valid skill name", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.put("/api/skills/NOT_A_NAME").pipe(
            HttpClientRequest.bodyJsonUnsafe({ files: { "SKILL.md": "x" } })
          )
        );
        return response.status;
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("ok")])])))
    );
    expect(status).toBe(400);
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

  it("offers Software, creates a conversation with it and adds more with an Upgrade", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const capabilities = yield* client.info.capabilities();
        expect(
          capabilities.software.map((each) => [each.id, each.level])
        ).toStrictEqual([
          ["node", "shell"],
          ["uv", "shell"],
          ["python-data", "shell"],
          ["imagemagick", "shell"],
          ["ffmpeg", "shell"],
          ...(process.arch === "x64" ? [["chrome", "desktop"]] : []),
        ]);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", software: ["node"], prompt: "hello" },
        });
        const upgraded = yield* client.conversations.upgrade({
          params: { id: created.id },
          payload: { software: ["uv"] },
        });
        const nothing = yield* Effect.flip(
          client.conversations.upgrade({
            params: { id: created.id },
            payload: {},
          })
        );
        expect([
          created.software,
          upgraded.software,
          upgraded.sandbox,
          nothing._tag,
        ]).toStrictEqual([["node"], ["node", "uv"], "shell", "InvalidUpgrade"]);
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("a")])])))
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
      Layer.provideMerge(sandboxes.layer),
      Layer.provide(Skills.none),
      Layer.provideMerge(Attachments.temporary()),
      Layer.provideMerge(Artifacts.temporary()),
      Layer.provideMerge(TrustedDomains.temporary()),
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
      '<pre id="d">graph TD; A-->B</pre><script src="/api/artifact-libs/pele.global.js"></script>';
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
        const lib = yield* http.get("/api/artifact-libs/pele.global.js");
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
        csp: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
        type: expect.stringContaining("text/html"),
        nosniff: "nosniff",
        body: expect.stringContaining("/api/artifact-libs/pele.global.js"),
      },
      lib: {
        status: 200,
        type: expect.stringContaining("javascript"),
        nosniff: "nosniff",
        body: expect.stringContaining("pele"),
      },
      missingLib: 404,
      source: { version: 1, html: expect.stringContaining("graph TD") },
      view: { id: result.view.id, title: "Diagram" },
      removed: { _tag: "ArtifactNotFound" },
    });
    expect(result.lib.body.length).toBeGreaterThan(100_000);
    expect(result.view.versions).toHaveLength(1);
  });

  it("edits the trusted domains from the API and puts them in a page's CSP", async () => {
    const agents = fauxAgents([
      // First refused: the image's host is not trusted yet.
      page("call-1", "Results", '<img src="https://cdn.example.com/a.png">'),
      echoToolResult,
      // Same page again after the domain was trusted — accepted this time.
      page("call-2", "Results", '<img src="https://cdn.example.com/a.png">'),
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const http = yield* HttpClient.HttpClient;
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "a page" },
        });
        yield* waitUntil(
          Effect.sync(() => agents.faux.getPendingResponseCount() === 2)
        );
        const refused = yield* client.artifacts.list({
          query: { conversation: created.id },
        });
        const added = yield* client.trustedDomains.add({
          payload: { domain: "https://cdn.example.com/a.png" },
        });
        const invalid = yield* Effect.flip(
          client.trustedDomains.add({ payload: { domain: "not a domain!" } })
        );
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "try again" },
        });
        const listArtifacts = () =>
          client.artifacts.list({ query: { conversation: created.id } });
        yield* waitUntil(
          Effect.map(listArtifacts(), (views) => views.length > 0)
        );
        const [artifact] = yield* listArtifacts();
        if (artifact === undefined) {
          return yield* Effect.die(new Error("no artifact created"));
        }
        const cspOf = () =>
          Effect.map(
            http.get(
              `/api/artifacts/${artifact.id}/render?conversation=${created.id}`
            ),
            (render) => render.headers["content-security-policy"]
          );
        const csp = yield* cspOf();
        const list = yield* client.trustedDomains.list();
        yield* client.trustedDomains.remove({
          params: { domain: added.domain },
        });
        const gone = yield* cspOf();
        return { refused, added, invalid, csp, list, gone };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result).toMatchObject({
      refused: [],
      added: { domain: "cdn.example.com" },
      list: ["cdn.example.com"],
    });
    expect(result.invalid).toMatchObject({ _tag: "InvalidDomain" });
    expect(result.csp).toContain("img-src data: blob: 'self' cdn.example.com");
    expect(result.gone).not.toContain("cdn.example.com");
  });

  it("serves a conversation's workspace files, confined to the workspace", async () => {
    const agents = fauxAgents([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        const [dir] = [...agents.sandboxes.stored];
        if (dir === undefined) {
          return yield* Effect.die(new Error("no workspace storage"));
        }
        mkdirSync(path.join(dir, "sub"));
        writeFileSync(path.join(dir, "REPORT.md"), "# Report\n\nHello.\n");
        writeFileSync(path.join(dir, "sub", "notes.txt"), "deep\n");
        writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
        const list = (file?: string) =>
          client.files.list({
            params: { id: created.id },
            query: file === undefined ? {} : { path: file },
          });
        const content = (file: string) =>
          client.files.content({
            params: { id: created.id },
            query: { path: file },
          });
        const listing = yield* list();
        const sub = yield* list("sub");
        const tree = yield* client.files.tree({ params: { id: created.id } });
        const onFile = yield* Effect.flip(list("REPORT.md"));
        const report = yield* content("REPORT.md");
        const deep = yield* content("sub/notes.txt");
        const binary = yield* content("blob.bin");
        const missing = yield* Effect.flip(content("nope.md"));
        const escaped = yield* Effect.flip(content("../REPORT.md"));
        const absolute = yield* Effect.flip(content("/etc/hostname"));
        const onDir = yield* Effect.flip(content("sub"));
        // Stop returns once nothing runs, so the Pause closes the Seat at once.
        yield* client.conversations.stop({ params: { id: created.id } });
        yield* client.conversations.pause({ params: { id: created.id } });
        const paused = yield* Effect.flip(list());
        const none = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi" },
        });
        const levelNone = yield* Effect.flip(
          client.files.list({ params: { id: none.id }, query: {} })
        );
        return {
          listing,
          sub,
          tree,
          onFile,
          report,
          deep,
          binary,
          missing,
          escaped,
          absolute,
          onDir,
          paused,
          levelNone,
        };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result.listing).toMatchObject({
      truncated: false,
      entries: [
        { name: "sub", path: "sub", kind: "directory" },
        { name: "blob.bin", path: "blob.bin", kind: "file" },
        { name: "REPORT.md", path: "REPORT.md", kind: "file" },
      ],
    });
    expect(result.sub.entries).toMatchObject([
      { name: "notes.txt", path: "sub/notes.txt", kind: "file" },
    ]);
    expect(result.tree).toStrictEqual({
      truncated: false,
      // Depth-first, directories first, a trailing "/" on directories.
      paths: ["sub/", "sub/notes.txt", "blob.bin", "REPORT.md"],
    });
    expect([result.report, result.deep, result.binary]).toStrictEqual([
      {
        path: "REPORT.md",
        size: 17,
        truncated: false,
        binary: false,
        text: "# Report\n\nHello.\n",
      },
      {
        path: "sub/notes.txt",
        size: 5,
        truncated: false,
        binary: false,
        text: "deep\n",
      },
      { path: "blob.bin", size: 3, truncated: false, binary: true },
    ]);
    expect(
      [
        result.onFile,
        result.missing,
        result.escaped,
        result.absolute,
        result.onDir,
        result.paused,
        result.levelNone,
      ].map((failed) => failed._tag)
    ).toStrictEqual([
      "WorkspaceFileNotFound",
      "WorkspaceFileNotFound",
      "WorkspaceFileNotFound",
      "WorkspaceFileNotFound",
      "WorkspaceFileNotFound",
      "SandboxUnavailable",
      "SandboxUnavailable",
    ]);
  });

  it("lists every conversation's artifacts without a scope, each carrying its conversation", async () => {
    const agents = fauxAgents([
      page("call-1", "First page", "<p>1</p>"),
      echoToolResult,
      page("call-2", "Second page", "<p>2</p>"),
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const artifactsOf = (conversation?: number) =>
          client.artifacts.list({
            query: conversation === undefined ? {} : { conversation },
          });
        const first = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "first page" },
        });
        yield* waitUntil(
          Effect.map(artifactsOf(first.id), (views) => views.length === 1)
        );
        // Both of the first conversation's queued turns are spent, so the next
        // conversation's run takes the second pair of responses.
        yield* waitUntil(
          Effect.sync(() => agents.faux.getPendingResponseCount() === 2)
        );
        const second = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "second page" },
        });
        yield* waitUntil(
          Effect.map(artifactsOf(), (views) => views.length === 2)
        );
        return {
          ids: [first.id, second.id],
          all: yield* artifactsOf(),
          scoped: yield* artifactsOf(first.id),
        };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(
      result.all.map((row) => [row.title, row.conversation])
    ).toStrictEqual([
      ["Second page", result.ids[1]],
      ["First page", result.ids[0]],
    ]);
    expect(result.scoped.map((row) => row.conversation)).toStrictEqual([
      result.ids[0],
    ]);
  });
});

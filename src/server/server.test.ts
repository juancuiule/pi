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
import { Capacity } from "../capacity.ts";
import { Skills } from "../skills/skills.ts";
import { fauxAgents } from "../testing/faux.ts";
import { fakeMcpServer } from "../testing/mcp.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { echoModel } from "./faux.ts";
import { ApiLayer } from "./handlers.ts";

const serverWith = (agents: Layer.Layer<Agents | Capacity, AgentError>) =>
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
      ["calculator", "coding-tools", "desktop", "workspace", "tracing"].map(
        (name) => byName.get(name)?.levels
      )
    ).toStrictEqual([
      ["none", "shell", "desktop"],
      ["shell", "desktop"],
      ["desktop"],
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
    // A chat runs with the calculator, the workspace tool and the locked tracing; nothing that needs a sandbox.
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
      ["calculate", "upgrade_workspace"],
      ["coding-tools", "desktop"],
      ["workspace"],
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
});
